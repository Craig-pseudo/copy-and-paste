/*
 * Facade / barrel module.
 *
 * Blazor's TrimbleModulePath points at THIS file, so every function
 * Blazor calls via _trimbleModule.InvokeAsync("name", ...) must be a
 * genuine export here.
 *
 * IMPORTANT: this file must contain NO state and NO implementations.
 * It previously held a full second copy of the viewer engine,
 * including its own `let workspaceAPI = null`. Because ES modules are
 * per-file singletons, initializeViewer() (which lives in
 * trimbleDashboard.js) set trimbleWorkspace.js's workspaceAPI while
 * selectTrimbleObject() read THIS file's copy - which nothing ever
 * set. That is what produced:
 *
 *   TypeError: Cannot read properties of null (reading 'viewer')
 *
 * Everything below is re-exported so there is exactly one instance of
 * the viewer engine, living in trimbleWorkspace.js.
 */

// Auth + viewer lifecycle (trimbleDashboard.js re-exports the
// trimbleAuth.js ones itself).
export {
    openViewerPopup,
    initialize,
    requestAccessToken,
    dispose,
    initializeViewer,
    refreshToken,
    disposeViewer,
    scrollToAssetRow
} from "/js/trimbleDashboard.js";

// Viewer operations - straight from the engine, not via the dashboard,
// so there is no chance of a stale re-export chain.
export {
    setElementColors,
    selectUnmatchedTrimbleObjects,
    selectTrimbleObject,
    clearViewerSelection,
    getAllFlattenedObjects,
    getAllLoadedObjects,
    getFlattenedObjectByRuntimeId,
    getSelection,
    zoomToSelection,
    ifcGuidToUuid
} from "/js/trimbleWorkspace.js";

// Wiring helpers - exported in case the Razor calls them directly.
export {
    setViewerDotNetReference,
    setWorkspaceApi,
    getWorkspaceApi,
    handleViewerEvent
} from "/js/trimbleWorkspace.js";
