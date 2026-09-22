import {
    handleViewerEvent,
    disposeViewer
} from "./trimbleWorkspace.js";

let api = null;
let dotNetReference = null;

let initialized = false;
let cachedAccessToken = null;

let viewerPopup = null;
let currentProject = null;

/**
 * Base URL for Trimble Connect's own web 3D viewer. The popup opens
 * "{TRIMBLE_VIEWER_BASE_URL}/{projectId}/viewer/3d"
 */
const TRIMBLE_VIEWER_BASE_URL = "https://web.connect.trimble.com/projects";

const BASE_URL = "https://paramaticremotecontrolc-plantvision-c7grdrc5c6csdkdy.centralus-01.azurewebsites.net";
const DEBUG_URL = "https://hertz-stool-creole.ngrok-free.dev";

/**
 * Name given to the viewer popup window. window.open() sets this as
 * the popup's browsing-context name, which persists across
 * navigation
 */
const VIEWER_WINDOW_NAME = "trimble-3d-viewer";

/**
 * sessionStorage key holding the last viewer URL we opened the
 * popup to. Set right before window.open() so it is present in the
 * popup's own sessionStorage from the moment it is created (a new
 * window opened via window.open() from the same origin receives a
 * copy of the opener's sessionStorage at creation time).
 */
const VIEWER_RETURN_URL_KEY = "paramatic.viewerReturnUrl";

(function redirectIfViewerPopupWasHijacked() {
    if (window.name !== VIEWER_WINDOW_NAME) {
        return;
    }

    let returnUrl = null;

    try {
        returnUrl = sessionStorage.getItem(VIEWER_RETURN_URL_KEY);
    } catch (error) {
        console.warn(
            "[ParaMatic] Could not read the viewer return URL " +
            "from sessionStorage:",
            error
        );
    }

    if (!returnUrl) {
        return;
    }

    console.warn(
        "[ParaMatic] This page loaded inside the 3D viewer popup " +
        "window, which means Trimble navigated it away from the " +
        "viewer. Redirecting back to the viewer."
    );

    window.location.replace(returnUrl);
})();

/**
 * Opens Trimble Connect's own 3D viewer for the current project in
 * a popup window, or focuses it if it is already open.
 */
export function openViewerPopup() {
    try {
        const projectId = currentProject?.id;

        if (!projectId) {
            console.warn(
                "[ParaMatic] Cannot open the 3D viewer popup - no " +
                "current project id is available."
            );

            return;
        }

        if (viewerPopup && !viewerPopup.closed) {
            console.log(
                "[ParaMatic] 3D viewer popup is already open. Focusing it."
            );

            viewerPopup.focus();

            return;
        }

        const popupUrl = `${TRIMBLE_VIEWER_BASE_URL}/${projectId}/viewer/3d`;

        try {
            sessionStorage.setItem(VIEWER_RETURN_URL_KEY, popupUrl);
        } catch (error) {
            console.warn(
                "[ParaMatic] Could not store the viewer return URL in " +
                "sessionStorage:",
                error
            );
        }

        viewerPopup = window.open(
            popupUrl,
            VIEWER_WINDOW_NAME,
            "width=1280,height=800"
        );

        if (!viewerPopup) {
            console.warn(
                "[ParaMatic] The 3D viewer popup was blocked by the " +
                "browser. The user may need to allow popups for this site."
            );

            return;
        }

        console.log(
            "[ParaMatic] Opened the Trimble Connect 3D viewer popup " +
            `for project ${projectId}.`
        );
    } catch (error) {
        /*
         * Opening the viewer popup is a nice-to-have side effect of
         * getting an access token, not part of the token flow
         * itself. Never let a failure here (blocked popups, window
         * name conflicts, sandboxed-iframe restrictions, etc.)
         * propagate up and be mistaken for a failed token request.
         */
        console.error(
            "[ParaMatic] Failed to open the 3D viewer popup:",
            error
        );
    }
}

/**
 * Initializes the ParaMatic Trimble Connect Project Extension.
 *
 * Called from Blazor using:
 *
 * _module.InvokeAsync<ExtensionContext>(
 *     "initialize",
 *     _dotNetReference);
 *
 * @param {any} reference Blazor DotNetObjectReference.
 * @returns {Promise<object>}
 */
export async function initialize(reference) {
    console.log(
        "[ParaMatic] Initializing Trimble Project Extension..."
    );

    dotNetReference = reference;

    if (!window.TrimbleConnectWorkspace) {
        throw new Error(
            "TrimbleConnectWorkspace is undefined. " +
            "Ensure the Trimble Workspace API script is loaded."
        );
    }

    /*
     * A registered Trimble extension runs inside an iframe.
     *
     * When window.parent === window, the page was opened directly
     * instead of through Trimble Connect.
     */
    if (window.parent === window) {
        console.warn(
            "[ParaMatic] This page is not running inside Trimble Connect. " +
            "Open it through the registered project extension."
        );

        return {
            isRunningInTrimble: false,
            project: null,
            user: null
        };
    }

    try {
        if (!api) {
            console.log(
                "[ParaMatic] Connecting to Trimble Connect parent..."
            );

            api = await window.TrimbleConnectWorkspace.connect(
                window.parent,
                handleTrimbleEvent,
                30000
            );

            console.log(
                "[ParaMatic] Connected to Trimble Connect."
            );
        }

        await configureMenu();

        const project = await getCurrentProject();
        const user = await getCurrentUser();

        currentProject = project;

        initialized = true;

        console.log(
            "[ParaMatic] Extension initialized successfully."
        );

        console.log(
            "[ParaMatic] Current project:",
            project
        );

        return {
            isRunningInTrimble: true,
            project,
            user
        };
    } catch (error) {
        console.error(
            "[ParaMatic] Extension initialization failed:",
            error
        );

        api = null;
        initialized = false;

        throw error;
    }
}

/**
 * Registers the ParaMatic menu in the Trimble Connect
 * project side navigation.
 */
async function configureMenu() {
    ensureApiInitialized();

    const menu = {
        title: "Vision",
        icon: `${BASE_URL}/icon.png`,
        command: "dashboard",
        subMenus: [
            {
                title: "Dashboard",
                icon: `${BASE_URL}/icon.png`,
                command: "dashboard"
            }

        ]
    };

    console.log(
        "[ParaMatic] Registering extension menu:",
        menu
    );

    const menuResult = await api.ui.setMenu(menu);

    console.log(
        "[ParaMatic] Menu registration result:",
        menuResult
    );

    await api.ui.setActiveMenuItem("dashboard");

    console.log(
        "[ParaMatic] Dashboard menu item activated."
    );
}

/**
 * Handles events sent by Trimble Connect.
 *
 * Trimble event arguments normally contain the value
 * in args.data.
 *
 * @param {string} event
 * @param {any} args
 */
async function handleTrimbleEvent(event, args) {
    const data = extractEventData(args);

    console.log(
        "[ParaMatic] Trimble event:",
        event
    );

    switch (event) {
        case "extension.command":
            await handleCommand(data);
            break;

        case "extension.accessToken":
            await handleAccessToken(data);
            break;

        case "extension.userSettingsChanged":
            await notifyDotNet(
                "OnTrimbleUserSettingsChanged"
            );
            break;

        case "extension.sessionInvalid":
            console.warn(
                "[ParaMatic] Trimble session is invalid."
            );

            await notifyDotNet(
                "OnTrimbleSessionInvalid"
            );
            break;

        default:
            // Not an extension-shell event - hand it to the shared
            // viewer engine (e.g. selection/model-state events, if
            // the embedded viewer happens to be connected too).
            handleViewerEvent(event, data);
            break;
    }
}

/**
 * Extracts the data property from a Trimble event.
 *
 * @param {any} args
 * @returns {any}
 */
function extractEventData(args) {
    if (
        args !== null &&
        typeof args === "object" &&
        Object.prototype.hasOwnProperty.call(args, "data")
    ) {
        return args.data;
    }

    return args;
}

/**
 * Handles a menu command sent by Trimble Connect.
 *
 * @param {string} command
 */
async function handleCommand(command) {
    if (
        typeof command !== "string" ||
        command.trim().length === 0
    ) {
        console.warn(
            "[ParaMatic] Empty extension command received."
        );

        return;
    }

    console.log(
        "[ParaMatic] Extension command:",
        command
    );

    if (api) {
        try {
            await api.ui.setActiveMenuItem(command);
        } catch (error) {
            console.warn(
                `[ParaMatic] Could not activate menu item '${command}':`,
                error
            );
        }
    }

    await notifyDotNet(
        "OnTrimbleCommand",
        command
    );
}

export async function requestAccessToken() {
    ensureApiInitialized();

    console.log(
        "[ParaMatic] Requesting Trimble access-token permission..."
    );

    try {
        const result =
            await api.extension.requestPermission(
                "accesstoken"
            );

        console.log(
            "[ParaMatic] Access-token permission result:",
            describeTokenResult(result)
        );

        if (result === "pending") {
            return "pending";
        }

        if (result === "denied") {
            console.warn(
                "[ParaMatic] Token permission was denied. " +
                "Reset authorization in Trimble Connect extension settings."
            );

            return "denied";
        }

        if (
            typeof result !== "string" ||
            result.trim().length === 0
        ) {
            console.warn(
                "[ParaMatic] Trimble returned an empty token result."
            );

            return null;
        }

        /*
         * When permission was already granted, Trimble may
         * return the token directly.
         *
         * The Razor method calling this function will store it.
         */
        cachedAccessToken = result;

        console.log(
            `[ParaMatic] Access token returned directly ` +
            `(${result.length} characters).`
        );

        return result;
    } catch (error) {
        console.error(
            "[ParaMatic] Access-token permission request failed:",
            error
        );

        throw error;
    }
}

/**
 * Handles access-token events from Trimble Connect.
 *
 * Trimble sends this event after the user approves permission
 * and whenever the access token is refreshed.
 *
 * @param {string} result
 */
async function handleAccessToken(result) {
    if (result === "pending") {
        console.log(
            "[ParaMatic] Access-token event status: pending."
        );

        return;
    }

    if (result === "denied") {
        console.warn(
            "[ParaMatic] Access-token event status: denied."
        );

        cachedAccessToken = null;

        return;
    }

    if (
        typeof result !== "string" ||
        result.trim().length === 0
    ) {
        console.warn(
            "[ParaMatic] Empty extension.accessToken event received."
        );

        return;
    }

    cachedAccessToken = result;

    /*
     * Never log the token itself.
     */
    console.log(
        `[ParaMatic] Access token received through event ` +
        `(${result.length} characters).`
    );

    await notifyDotNet(
        "OnTrimbleAccessTokenChanged",
        result
    );
}

/**
 * Gets the current Trimble Connect project.
 *
 * @returns {Promise<object|null>}
 */
async function getCurrentProject() {
    ensureApiInitialized();

    try {
        return await api.project.getProject();
    } catch (error) {
        console.error(
            "[ParaMatic] Could not retrieve the current project:",
            error
        );

        throw error;
    }
}

/**
 * Gets the current Trimble Connect user.
 *
 * User retrieval is optional and will not prevent
 * the extension from initializing.
 *
 * @returns {Promise<object|null>}
 */
async function getCurrentUser() {
    ensureApiInitialized();

    if (
        !api.user ||
        typeof api.user.getUser !== "function"
    ) {
        console.warn(
            "[ParaMatic] api.user.getUser is unavailable."
        );

        return null;
    }

    try {
        const user = await api.user.getUser();

        console.log(
            "[ParaMatic] Current Trimble user received."
        );

        return user;
    } catch (error) {
        console.warn(
            "[ParaMatic] Could not retrieve the current user:",
            error
        );

        return null;
    }
}

/**
 * Returns the access token stored in this browser module.
 *
 * This is primarily useful for diagnostics.
 * Prefer storing the token through the Blazor token service.
 *
 * @returns {string|null}
 */
export function getCachedAccessToken() {
    return cachedAccessToken;
}

/**
 * Returns whether the Workspace API connection is initialized.
 *
 * @returns {boolean}
 */
export function isInitialized() {
    return initialized && api !== null;
}

/**
 * Calls a [JSInvokable] method on the Blazor component.
 *
 * @param {string} methodName
 * @param {any} value
 */
async function notifyDotNet(methodName, value) {
    if (!dotNetReference) {
        console.warn(
            `[ParaMatic] Cannot invoke '${methodName}'. ` +
            "The .NET object reference is unavailable."
        );

        return;
    }

    try {
        if (value === undefined) {
            await dotNetReference.invokeMethodAsync(
                methodName
            );
        } else {
            await dotNetReference.invokeMethodAsync(
                methodName,
                value
            );
        }
    } catch (error) {
        console.error(
            `[ParaMatic] Failed to invoke .NET method ` +
            `'${methodName}':`,
            error
        );
    }
}

/**
 * Verifies that the Trimble Workspace API connection exists.
 */
function ensureApiInitialized() {
    if (!api) {
        throw new Error(
            "Trimble Workspace API is not initialized. " +
            "Call initialize() before using this function."
        );
    }
}

/**
 * Produces a safe diagnostic description without
 * exposing the access token.
 *
 * @param {any} result
 * @returns {string}
 */
function describeTokenResult(result) {
    if (result === "pending") {
        return "pending";
    }

    if (result === "denied") {
        return "denied";
    }

    if (typeof result === "string") {
        return `token (${result.length} characters)`;
    }

    if (result === null) {
        return "null";
    }

    if (result === undefined) {
        return "undefined";
    }

    return typeof result;
}

/**
 * Cleans up the extension module when the Blazor
 * component is disposed.
 */
export function dispose() {
    console.log(
        "[ParaMatic] Disposing Trimble extension module."
    );

    dotNetReference = null;
    cachedAccessToken = null;
    api = null;
    initialized = false;
    viewerPopup = null;
    currentProject = null;

    // The embedded viewer connection lives in trimble-viewer-core.js
    // now - clear it too, same as before (safe even if already clear).
    disposeViewer();
}