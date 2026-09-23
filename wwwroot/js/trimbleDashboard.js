import {
    setViewerDotNetReference,
    setWorkspaceApi,
    getWorkspaceApi,
    handleViewerEvent,
    dispose as disposeSharedViewer
} from "./trimbleWorkspace.js";

import { openViewerPopup, initialize, requestAccessToken, dispose } from "./trimbleAuth.js";

/*
 * Re-exported here (not just imported) because Blazor's JS interop
 * calls _trimbleModule.InvokeAsync("functionName", ...), which reads
 * `module["functionName"]` directly off whichever file
 * TrimbleModulePath points at. An imported-but-not-re-exported
 * binding is not reachable that way - it has to be a genuine export
 * of *this* file.
 */
// export {
//     setElementColors,
//     selectTrimbleObject,
//     clearViewerSelection,
//     getAllFlattenedObjects,
//     getFlattenedObjectByRuntimeId,
//     getSelection,
//     zoomToSelection
// } from "./trimbleWorkspace.js";

export { openViewerPopup, initialize, requestAccessToken, dispose };

/**
 * Initializes the embedded Trimble Connect viewer.
 *
 * @param {HTMLIFrameElement} iframeElement
 * @param {string} accessToken
 * @param {string} projectId
 * @returns {Promise<boolean>}
 */
export async function initializeViewer(
    iframeElement,
    accessToken,
    projectId,
    modelId,
    dashboardReference
) {
    if (!(iframeElement instanceof HTMLIFrameElement)) {
        console.error(
            "[ParaMatic] A valid iframe element is required."
        );

        return false;
    }

    if (!accessToken) {
        console.error(
            "[ParaMatic] An access token is required."
        );

        return false;
    }

    if (!projectId) {
        console.error(
            "[ParaMatic] A project ID is required."
        );

        return false;
    }

    if (!window.TrimbleConnectWorkspace) {
        console.error(
            "[ParaMatic] TrimbleConnectWorkspace is not loaded."
        );

        return false;
    }

    setViewerDotNetReference(dashboardReference);

    try {
        if (!getWorkspaceApi()) {
            await loadEmbeddedViewerIframe(iframeElement);

            const connected =
                await window.TrimbleConnectWorkspace.connect(
                    iframeElement,
                    handleViewerEvent,
                    30000
                );

            setWorkspaceApi(connected);
        }

        const workspaceAPI = getWorkspaceApi();

        const tokenAccepted =
            await workspaceAPI.embed.setTokens({
                accessToken
            });

        if (!tokenAccepted) {
            console.error(
                "[ParaMatic] The embedded viewer rejected the token."
            );

            return false;
        }

        await workspaceAPI.embed.init3DViewer({
            projectId,
            modelId
        });

        console.log(
            "[ParaMatic] init3DViewer completed.",
            {
                projectId,
                modelId
            }
        );

        await workspaceAPI.ui.setUI({
            name: "SidePanel",
            state: "hidden"
        });

        /*
         * Don't rely only on viewer.onModelStateChanged.
         *
         * init3DViewer starts the loading process but depending on timing
         * the model-state event can be missed by the extension.
         */
        // await loadDashboardObjectsWhenReady(modelId);

        return true;
    } catch (error) {
        console.error(
            "[ParaMatic] Embedded viewer initialization failed.",
            error
        );

        setWorkspaceApi(null);

        return false;
    }
}

async function loadEmbeddedViewerIframe(iframeElement) {
    const currentSource =
        iframeElement.getAttribute("src") ?? "";

    if (
        currentSource &&
        currentSource !== "about:blank" &&
        currentSource !== "#"
    ) {
        return;
    }

    await new Promise((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
            cleanup();

            reject(
                new Error(
                    "Timed out loading the embedded Trimble viewer."
                )
            );
        }, 30000);

        const onLoad = () => {
            cleanup();
            resolve();
        };

        const onError = () => {
            cleanup();

            reject(
                new Error(
                    "The embedded Trimble viewer failed to load."
                )
            );
        };

        function cleanup() {
            window.clearTimeout(timeoutId);

            iframeElement.removeEventListener(
                "load",
                onLoad);

            iframeElement.removeEventListener(
                "error",
                onError);
        }

        iframeElement.addEventListener(
            "load",
            onLoad,
            { once: true });

        iframeElement.addEventListener(
            "error",
            onError,
            { once: true });

        iframeElement.src =
            "https://web.connect.trimble.com/?isEmbedded=true";
    });
}

// Lazily-built, cached once per viewer session: GUID (MS) -> {modelId, runtimeId}.
// Rebuilt (set back to null) whenever the viewer is disposed.
let guidToObjectRef = null;

/**
 * Highlights an object in the embedded 3D viewer by its GUID (MS).
 *
 * The GUID -> {modelId, runtimeId} lookup (buildGuidIndex/extractMsGuid
 * below) is built from confirmed working calls (viewer.getObjects,
 * viewer.getObjectProperties - same ones already used elsewhere in this
 * project). The actual highlight call, viewer.setSelection, is NOT yet
 * confirmed against this Trimble SDK version - it's the standard
 * documented shape ([{modelId, objectRuntimeIds}], mode), but if this
 * throws or silently does nothing, check the console error logged here
 * first and report it back before assuming something else is wrong.
 */
export async function selectObjectByGuid(guid) {
    const workspaceAPI = getWorkspaceApi();

    if (!workspaceAPI?.viewer) {
        console.warn("[ParaMatic] selectObjectByGuid: no active viewer connection.");
        return false;
    }

    try {
        if (!guidToObjectRef) {
            console.log("[ParaMatic] Building GUID index from loaded models...");
            guidToObjectRef = await buildGuidIndex(workspaceAPI);
            console.log(`[ParaMatic] GUID index built: ${guidToObjectRef.size} objects.`);
        }

        const ref = guidToObjectRef.get(guid.toLowerCase());

        if (!ref) {
            console.warn(`[ParaMatic] selectObjectByGuid: no object found for GUID ${guid} in loaded models.`);
            return false;
        }

        await workspaceAPI.viewer.setSelection(
            [{ modelId: ref.modelId, objectRuntimeIds: [ref.runtimeId] }],
            "set"
        );

        console.log(`[ParaMatic] Selected object ${guid} (model ${ref.modelId}, runtimeId ${ref.runtimeId}).`);

        return true;
    } catch (error) {
        console.error(`[ParaMatic] selectObjectByGuid failed for ${guid}:`, error);
        return false;
    }
}

/**
 * Walks every loaded model's objects, fetches their properties in
 * batches, and indexes them by GUID (MS) -> {modelId, runtimeId}.
 */
async function buildGuidIndex(workspaceAPI) {
    const index = new Map();

    const modelGroups = await workspaceAPI.viewer.getObjects();

    for (const modelGroup of modelGroups ?? []) {
        const modelId = modelGroup.modelId;

        const runtimeIds = (modelGroup.objects ?? [])
            .map(object => object.id)
            .filter(Number.isInteger);

        if (!modelId || runtimeIds.length === 0) continue;

        const batchSize = 250;

        for (let i = 0; i < runtimeIds.length; i += batchSize) {
            const batch = runtimeIds.slice(i, i + batchSize);

            let properties;

            try {
                properties = await workspaceAPI.viewer.getObjectProperties(modelId, batch);
            } catch (error) {
                console.error(`[ParaMatic] getObjectProperties failed for model ${modelId}:`, batch, error);
                continue;
            }

            for (const object of properties ?? []) {
                const msGuid = extractMsGuid(object);

                if (msGuid) {
                    index.set(msGuid.toLowerCase(), { modelId, runtimeId: object.id });
                } else {
                    // Log the raw shape once so we can see the real property
                    // names/structure if the GUID (MS) property isn't found
                    // where expected - this is a guess at the property set
                    // shape based on the "GUID (MS)" label seen in the UI.
                    console.warn("[ParaMatic] No GUID (MS) property found on object - raw shape:", object);
                }
            }
        }
    }

    return index;
}

function extractMsGuid(objectProperties) {
    for (const set of objectProperties?.properties ?? []) {
        for (const prop of set?.properties ?? []) {
            if (typeof prop?.name === "string" && /guid.*\(?ms\)?/i.test(prop.name)) {
                return prop.value ?? null;
            }
        }
    }

    return null;
}

/**
 * Refreshes the OAuth token.
 */
export async function refreshToken(accessToken) {
    const workspaceAPI = getWorkspaceApi();

    if (!workspaceAPI)
        return false;

    try {

        await workspaceAPI.embed.setTokens({
            accessToken: accessToken
        });

        return true;
    }
    catch (e) {

        console.error(e);
        return false;
    }
}

/**
 * Tears down the embedded 3D viewer connection only.
 *
 * Called from TrimbleDashboard.razor when that component is disposed
 * (e.g. navigating away from the dashboard tab). Unlike
 * trimble-extension.js's dispose(), this does not clear the outer
 * extension connection (`api`, `dotNetReference`, `cachedAccessToken`)
 * since the extension shell (TrimbleExtension.razor) may still be
 * mounted and connected.
 */
export function disposeViewer() {
    guidToObjectRef = null;
    disposeSharedViewer();
}

/**
 * Scrolls the given asset's row into view in the dashboard's sidebar
 * list, if it's not already fully visible. DOM-only, no Trimble state
 * - kept here since it's purely a dashboard UI concern.
 */
export function scrollToAssetRow(ifcGuid) {
    if (!ifcGuid) return;

    const element = document.getElementById(`asset-row-${ifcGuid}`);

    if (!element) {
        console.warn(`Asset row '${ifcGuid}' was not found.`);
        return;
    }

    const container = element.closest(".asset-list");

    if (!container) {
        element.scrollIntoView({
            behavior: "smooth",
            block: "center"
        });

        return;
    }

    const elementRect = element.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    const isVisible =
        elementRect.top >= containerRect.top &&
        elementRect.bottom <= containerRect.bottom;

    if (!isVisible) {
        element.scrollIntoView({
            behavior: "smooth",
            block: "center",
            inline: "nearest"
        });
    }
}

/*
 * Unrelated to Trimble entirely (a chart-width DOM helper) - carried
 * over as-is from the pre-split file rather than silently dropped.
 * Worth moving to its own small file later if it's actually used by a
 * chart component somewhere.
 */
window.trendChart = {
    getWidth: function (element) {
        if (!element) {
            return 0;
        }

        return element.getBoundingClientRect().width;
    }
};
