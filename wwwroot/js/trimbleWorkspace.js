let api = null;
let dotNetReference = null;

const DEBUG_URL = "https://hertz-stool-creole.ngrok-free.dev";
const BASE_URL = "https://paramaticremotecontrolc-plantvision-c7grdrc5c6csdkdy.centralus-01.azurewebsites.net";
 
// Called from Blazor to connect to the Trimble Connect parent window.
export async function initialize(reference) {
    dotNetReference = reference;
 
    // If not inside Trimble Connect, bail out.
    if (window.parent === window) {
        console.warn("Not running inside Trimble Connect.");
        return { isRunningInTrimble: false };
    }
 
    // Connect to the Trimble Connect host.
    api = await window.TrimbleConnectWorkspace.connect(
        window.parent,
        handleEvent,
        30000
    );
 
    // Register a menu item in the sidebar.
    await api.ui.setMenu({
        title: "Plant Vision",
        icon: `${BASE_URL}/icon.png`,
        command: "dashboard"
    });
 
    // Get the current project.
    const project = await api.project.getProject();


    console.log("Trimble Workspace API:", api);
    console.log("Viewer API:", api.viewer);
    console.log("Project API:", api.project);



 
    return {
        isRunningInTrimble: true,
        project
    };


}
 
// Called from Blazor when the user wants an access token.
export async function requestAccessToken() {
    if (!api) return null;
 
    const result = await api.extension.requestPermission("accesstoken");
 
    // "pending" -> user hasn't decided yet
    // "denied"  -> user said no
    // string    -> the actual token
    return result;
}
 
// Called from Blazor when the dashboard component is disposed.
export function dispose() {
    api = null;
    dotNetReference = null;
}
 
// Handles events from Trimble Connect.
function handleEvent(event, args) {
    const data = args?.data ?? args;
 
    console.log("Trimble event:", event, data);
 
    if (event === "extension.accessToken") {
        // Token came in asynchronously (after user approved).
        dotNetReference?.invokeMethodAsync("OnTrimbleAccessToken", data);
    }
 
    if (event === "extension.command") {
        // User clicked your menu item.
        dotNetReference?.invokeMethodAsync("OnTrimbleCommand", data);
    }

    if(event == "viewer.selectionChanged"){
        console.log("Object has been clicked");
    }
}

let viewerApi = null;
let viewerDotNetReference = null;

export function setViewerDotNetReference(reference) {
    viewerDotNetReference = reference;
}

export function setWorkspaceApi(instance) {
    viewerApi = instance;
}

export function getWorkspaceApi() {
    return viewerApi;
}

// Handles events from the embedded 3D viewer iframe.
export function handleViewerEvent(event, args) {
    const data = args?.data ?? args;

    if (event === "extension.accessToken") {
        // Token came in asynchronously (after user approved).
        dotNetReference?.invokeMethodAsync("OnTrimbleAccessToken", data);
    }
 
    if (event === "extension.command") {
        // User clicked your menu item.
        dotNetReference?.invokeMethodAsync("OnTrimbleCommand", data);
    }

    if(event == "viewer.onSelectionChanged"){
        console.log("[Vision]: on object has been selected");
    }

    viewerDotNetReference?.invokeMethodAsync("OnTrimbleEvent", event, data);
}

export function disposeViewer() {
    viewerApi = null;
    viewerDotNetReference = null;
}
