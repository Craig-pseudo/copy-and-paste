// Shared Trimble viewer engine.
//
// This holds every piece of logic that operates on `workspaceAPI`.
//
// NOTE: this file deliberately contains NO extension-shell state.
// `api`, `dotNetReference`, `initialize()`, `handleEvent()`,
// `requestAccessToken()` and `dispose()` live in trimbleAuth.js and
// must not be duplicated here - two modules each owning a private
// copy of the DotNet reference is what caused handleViewerEvent() to
// bail out with "Dotnet Reference is Empty" on every viewer event.

let workspaceAPI = null;
let viewerDotNetReference = null;
let UnMatchedRuntimeIds = null;

const PROPERTY_BATCH_SIZE = 250;
const PROPERTY_BATCH_CONCURRENCY = 3;
const MODEL_CONCURRENCY = 2;
const GUID_BATCH_SIZE = 50;
const GUID_BATCH_CONCURRENCY = 2;

/*
 * Plant asset names recognised by the dashboard. Keep this in sync
 * with AllowedTrimbleAssetNames / GetAssetType in
 * TrimbleDashboard.razor / PlantDataService.cs - this is the JS-side
 * mirror used to split "real" plant assets from everything else in
 * the model (structural steel, walkways, etc.) before objects are
 * sent to Blazor.
 */
const ASSET_NAMES = new Set([
    "Pre-Conditioner",
    "Extruder",
    "Cyclone",
    "Motor",
    "Dryer",
    "Cooler",
    "Tank",
    "Valve",
    "Fan",
    "Bucket Elevator",
    "Nebulizer",
    "Conveyor",
    "Chute",
    "Coater",
    "Surge Bin",
    "Live Bin"
]);

/*
 * Only these property names are copied onto the flattened object.
 * This must stay in sync with the [JsonPropertyName(...)] members of
 * IfcObjectJson in PlantDataService.cs - anything not read there is
 * dead weight over the SignalR wire and was previously blowing past
 * Blazor Server's default 32 KB message size limit for models with
 * many objects/property sets.
 */
const IFC_OBJECT_JSON_PROPERTY_NAMES = new Set([
    "PART_POS",
    "ASSEMBLY_POS",
    "Name",
    "NAME",
    "PROFILE",
    "ProfileName",
    "Material",
    "MATERIAL_TYPE",
    "Finish",
    "Class",
    "Height",
    "Width",
    "Length",
    "LENGTH_NET",
    "LENGTH_GROSS",
    "Area",
    "Volume",
    "Weight",
    "WEIGHT_NET",
    "WEIGHT_GROSS",
    "NetWeight"
]);

/**
 * Sets the DotNetObjectReference the dashboard-related notifications
 * below invoke methods on. Called by trimbleDashboard.js's
 * initializeViewer() once it has a reference from Blazor.
 */
export function setViewerDotNetReference(reference) {
    viewerDotNetReference = reference;
}

/**
 * Sets the connected workspaceAPI instance. Called by
 * trimbleDashboard.js's initializeViewer() once
 * TrimbleConnectWorkspace.connect() resolves.
 */
export function setWorkspaceApi(api) {
    workspaceAPI = api;
}

export function getWorkspaceApi() {
    return workspaceAPI;
}

/**
 * Tears down the embedded 3D viewer connection only. Exported so both
 * trimbleDashboard.js (Blazor calls this directly when the dashboard
 * component is disposed) and trimbleAuth.js's dispose() (which also
 * needs to null this out) can use the same implementation.
 */
export function disposeViewer() {
    console.log(
        "[ParaMatic] Disposing the embedded 3D viewer connection."
    );

    workspaceAPI = null;
    viewerDotNetReference = null;
}

function getViewer() {
    if (!workspaceAPI?.viewer) {
        console.error("Trimble viewer is not initialized.");
        return null;
    }

    return workspaceAPI.viewer;
}

async function notifyViewerDotNet(
    methodName,
    value
) {
    if (!viewerDotNetReference) {
        console.warn(
            `[ParaMatic] Cannot invoke dashboard method ` +
            `'${methodName}' because the dashboard reference ` +
            `is unavailable.`
        );

        return;
    }

    try {
        if (value === undefined) {
            await viewerDotNetReference.invokeMethodAsync(
                methodName);
        } else {
            await viewerDotNetReference.invokeMethodAsync(
                methodName,
                value);
        }
    } catch (error) {
        console.error(
            `[ParaMatic] Failed to invoke dashboard method ` +
            `'${methodName}'.`,
            error
        );
    }
}

function delay(milliseconds) {
    return new Promise(resolve =>
        window.setTimeout(resolve, milliseconds)
    );
}

async function normalizeViewerSelection(eventData) {
    const source =
        eventData?.data ??
        eventData?.selection ??
        eventData ??
        [];

    const groups = Array.isArray(source)
        ? source
        : Array.isArray(source?.selection)
            ? source.selection
            : [];

    const result = [];

    for (const group of groups) {
        const modelId =
            group?.modelId ??
            group?.model?.id ??
            null;

        const runtimeIds =
            Array.isArray(group?.objectRuntimeIds)
                ? group.objectRuntimeIds
                : [];

        for (const value of runtimeIds) {
            const runtimeId = Number(value);

            if (!Number.isInteger(runtimeId)) {
                continue;
            }

            result.push({
                modelId,
                runtimeId,
                objectId: null,
                ifcGuid: null,
                msGuid: null
            });
        }

        // Also support a flat single-object event.
        const singleRuntimeId = Number(
            group?.runtimeId ??
            group?.objectRuntimeId);

        if (
            Number.isInteger(singleRuntimeId) &&
            !runtimeIds.includes(singleRuntimeId)
        ) {
            result.push({
                modelId,
                runtimeId: singleRuntimeId,
                objectId: group?.objectId ?? null,
                ifcGuid: null,
                msGuid: group?.msGuid ?? group?.guid ?? null
            });
        }
    }

    /*
     * Resolve ifcGuid per model, since convertToObjectIds (like
     * convertToObjectRuntimeIds) is scoped to a single model and
     * batching per-model avoids one round trip per selected object.
     */
    const entriesByModelId = new Map();

    for (const entry of result) {
        if (!isNonEmptyString(entry.modelId)) {
            continue;
        }

        if (!entriesByModelId.has(entry.modelId)) {
            entriesByModelId.set(entry.modelId, []);
        }

        entriesByModelId.get(entry.modelId).push(entry);
    }

    await mapWithConcurrency(
        [...entriesByModelId.entries()],
        MODEL_CONCURRENCY,
        async ([modelId, entries]) => {
            const runtimeIds = entries.map(entry => entry.runtimeId);

            const guidMap = await getIfcGuidsByRuntimeId(
                modelId,
                runtimeIds
            );

            for (const entry of entries) {
                entry.ifcGuid = guidMap.get(entry.runtimeId) ?? null;
            }
        }
    );

    return result;
}

export async function selectUnmatchedTrimbleObjects(unmatchedIds) {
    if (!workspaceAPI) {
        return 0;
    }

    // If the caller didn't supply explicit ids, use the ids cached
    // from the last partitionObjectsByAssetName() run.
    if (!Array.isArray(unmatchedIds) || unmatchedIds.length === 0) {
        if (!UnMatchedRuntimeIds || UnMatchedRuntimeIds.size === 0) {
            console.warn(
                "[ParaMatic] No cached unmatched runtime IDs available " +
                "to select."
            );

            return 0;
        }

        unmatchedIds = [...UnMatchedRuntimeIds.entries()]
            .flatMap(([modelId, runtimeIds]) =>
                runtimeIds.map(runtimeId => ({ modelId, runtimeId })));
    }

    const idsByModel = new Map();

    for (const item of unmatchedIds) {
        const modelId = item?.modelId ?? item?.ModelId;
        const runtimeId = item?.runtimeId ?? item?.RuntimeId;

        if (!modelId || !Number.isInteger(runtimeId)) {
            continue;
        }

        if (!idsByModel.has(modelId)) {
            idsByModel.set(modelId, []);
        }

        idsByModel.get(modelId).push(runtimeId);
    }

    const modelObjectIds = [...idsByModel.entries()]
        .map(([modelId, runtimeIds]) => ({
            modelId,
            objectRuntimeIds: runtimeIds
        }));

    const selector = { modelObjectIds };

    await workspaceAPI.viewer.setObjectState(
        undefined,
        { opacity: 0.25 }
    );

    await workspaceAPI.viewer.setObjectState(
        selector,
        {
            visible: true,
            opacity: 1
        }
    );

    await workspaceAPI.viewer.setSelection(
        selector,
        "set"
    );

    return modelObjectIds.reduce(
        (count, group) =>
            count + group.objectRuntimeIds.length,
        0
    );
}

async function loadDashboardObjectsWhenReady(
    expectedModelId,
    maxAttempts = 30,
    delayMs = 500
) {
    if (!workspaceAPI) {
        console.warn(
            "[ParaMatic] Cannot load dashboard objects because " +
            "Workspace API is unavailable."
        );

        return;
    }

    console.log(
        "[ParaMatic] Waiting for Trimble model objects...",
        {
            expectedModelId
        }
    );

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const modelGroups =
                await workspaceAPI.viewer.getObjects();

            console.log(
                `[ParaMatic] getObjects attempt ${attempt}/${maxAttempts}`,
                modelGroups
            );

            if (
                Array.isArray(modelGroups) &&
                modelGroups.length > 0
            ) {
                const hasObjects =
                    modelGroups.some(group => {
                        const runtimeIds =
                            getRuntimeIds(group);

                        return runtimeIds.length > 0;
                    });

                if (hasObjects) {
                    console.log(
                        "[ParaMatic] Model objects are available."
                    );

                    await sendLoadedObjectsToDashboard();

                    return;
                }
            }
        } catch (error) {
            console.warn(
                `[ParaMatic] Model object check ${attempt} failed.`,
                error
            );
        }

        await delay(delayMs);
    }

    console.error(
        "[ParaMatic] Timed out waiting for model objects.",
        {
            expectedModelId,
            maxAttempts
        }
    );
}

async function sendLoadedObjectsToDashboard() {
    try {
        console.log(
            "[ParaMatic] Retrieving flattened model objects..."
        );

        const objects =
            await getAllFlattenedObjects();

        console.log(
            `[ParaMatic] Retrieved ${objects.length} flattened objects.`,
            objects
        );

        if (objects.length === 0) {
            console.warn(
                "[ParaMatic] No flattened Trimble objects were returned."
            );

            return;
        }

        const { matched, unmatchedRuntimeIds } =
            partitionObjectsByAssetName(objects);

        console.log(
            `[ParaMatic] ${matched.length} objects matched a configured ` +
            `asset name. ${objects.length - matched.length} did not.`,
            { unmatchedRuntimeIds }
        );

        if (matched.length === 0) {
            console.warn(
                "[ParaMatic] No objects matched a configured asset name."
            );

            return;
        }

        // await dimUnmatchedObjects(unmatchedRuntimeIds);

        console.log(
            "[ParaMatic] Sending objects to Blazor dashboard..."
        );

        await notifyViewerDotNet(
            "OnTrimbleModelObjectsLoaded",
            matched
        );

        console.log(
            "[ParaMatic] Objects successfully sent to Blazor dashboard."
        );
    } catch (error) {
        console.error(
            "[ParaMatic] Failed to send model objects to dashboard.",
            error
        );
    }
}

/**
 * Dims every object that didn't match a configured asset name, so
 * the plant assets sent to the dashboard stand out visually.
 *
 * @param {Map<string, number[]>} unmatchedRuntimeIdsByModel
 */
async function dimUnmatchedObjects(unmatchedRuntimeIdsByModel) {
    const viewer = getViewer();

    if (!viewer || unmatchedRuntimeIdsByModel.size === 0) {
        return;
    }

    const modelObjectIds = [...unmatchedRuntimeIdsByModel.entries()]
        .filter(([, runtimeIds]) => runtimeIds.length > 0)
        .map(([modelId, runtimeIds]) => ({
            modelId,
            objectRuntimeIds: runtimeIds
        }));

    if (modelObjectIds.length === 0) {
        return;
    }

    try {
        await viewer.setObjectState(
            { modelObjectIds },
            { opacity: 0.3 }
        );
    } catch (error) {
        console.error(
            "[ParaMatic] Failed to dim non-asset objects.",
            error
        );
    }
}

/**
 * Handles events from the connected workspaceAPI - called directly as
 * the callback passed to TrimbleConnectWorkspace.connect() in
 * trimbleDashboard.js's initializeViewer().
 *
 * There is deliberately no "is the DotNet reference set?" guard at
 * the top of this function. The reference used here is
 * `viewerDotNetReference` (set by setViewerDotNetReference during
 * initializeViewer), and notifyViewerDotNet() already handles the
 * case where it is missing.
 */
export async function handleViewerEvent(event, data) {

    console.log(
        "[ParaMatic] Viewer event:",
        event,
        data
    );

    if (event === "viewer.onModelStateChanged") {
        await handleModelStateChanged(data);
        return;
    }

    if (event !== "viewer.onSelectionChanged") {
        return;
    }

    const selections =
        await normalizeViewerSelection(data);

    if (selections.length === 0) {
        await notifyViewerDotNet(
            "OnTrimbleSelectionCleared"
        );

        return;
    }

    await notifyViewerDotNet(
        "OnTrimbleSelectionChanged",
        selections
    );
}

/**
 * Fired whenever a model's load state changes in the embedded
 * viewer. `init3DViewer` only kicks off loading - it does not wait
 * for the model geometry to finish loading - so object properties
 * must be queried only after this reports "loaded", not immediately
 * after `init3DViewer` resolves.
 */
async function handleModelStateChanged(data) {
    console.log(
        "[ParaMatic] viewer.onModelStateChanged:",
        data
    );

    const state =
        data?.data?.state ??
        data?.state;

    console.log(
        "[ParaMatic] Model state:",
        state
    );

    if (state !== "loaded") {
        return;
    }

    /*
     * Previously called sendLoadedObjectsToDashboard() here, which
     * queried properties for EVERY object in the model and sent them
     * all to Blazor as soon as the model finished loading. That's no
     * longer wanted - the dashboard should only ever learn about a
     * specific object when the user selects it in the viewer and
     * clicks "Add Asset", via getFlattenedObjectByRuntimeId() below.
     */
}

/**
 * Gets the currently selected model objects.
 */
export async function getSelection() {

    if (!workspaceAPI)
        return [];

    try {

        return await workspaceAPI.viewer.getSelection();

    }
    catch (e) {

        console.error(e);
        return [];
    }
}

/**
 * Zoom to selected objects.
 */
export async function zoomToSelection() {

    if (!workspaceAPI)
        return;

    try {

        const selection =
            await workspaceAPI.viewer.getSelection();

        if (selection.length === 0)
            return;

        await workspaceAPI.viewer.zoomToSelection(selection);

    }
    catch (e) {

        console.error(e);
    }
}

/**
 * Highlights an object in the embedded 3D viewer by its IFC GUID.
 *
 * NOTE: this replaces the old selectObjectByGuid/buildGuidIndex/
 * extractMsGuid approach, which walked every object in every model
 * and fetched properties in batches just to build a GUID lookup. The
 * SDK already exposes that lookup directly as
 * viewer.convertToObjectRuntimeIds, in one call. The old code also
 * indexed on "GUID (MS)" while the dashboard passes IFC GUIDs, so it
 * was matching on the wrong identifier.
 */
export async function selectTrimbleObject(
    modelId,
    ifcGuid,
    zoomToObject = true
) {
    if (!workspaceAPI) {
        console.warn(
            "[ParaMatic] The embedded viewer is not initialized."
        );

        return null;
    }

    const normalizedModelId =
        typeof modelId === "string"
            ? modelId.trim()
            : "";

    const normalizedIfcGuid =
        typeof ifcGuid === "string"
            ? ifcGuid.trim()
            : "";

    if (!normalizedModelId || !normalizedIfcGuid) {
        console.warn(
            "[ParaMatic] Model ID or IFC GUID is missing."
        );

        return null;
    }

    try {
        const runtimeIds =
            await workspaceAPI.viewer.convertToObjectRuntimeIds(
                normalizedModelId,
                [normalizedIfcGuid]
            );

        if (
            !Array.isArray(runtimeIds) ||
            runtimeIds.length === 0 ||
            runtimeIds[0] == null
        ) {
            console.warn(
                `[ParaMatic] No runtime ID found for IFC GUID ${normalizedIfcGuid}.`
            );

            return null;
        }

        const runtimeId = runtimeIds[0];

        const selectedSelector = {
            modelObjectIds: [
                {
                    modelId: normalizedModelId,
                    objectRuntimeIds: [runtimeId]
                }
            ]
        };

        /*
         * Dim everything in the viewer first, then highlight just the
         * selected object below. undefined means the ObjectState is
         * applied to all objects in all loaded models - this used to
         * dim only "unmatched" objects via UnMatchedRuntimeIds, but
         * that's only ever populated by the bulk auto-load flow, which
         * no longer runs (objects are now only fetched on demand, one
         * at a time, when the user selects them and clicks Add Asset).
         * UnMatchedRuntimeIds is therefore always null here now, which
         * is what was throwing.
         */
        await workspaceAPI.viewer.setObjectState(
            undefined,
            { opacity: 0.3 }
        );

        /*
         * Highlight the selected object.
         */
        await workspaceAPI.viewer.setObjectState(
            selectedSelector,
            {
                visible: true,
                opacity: 1.0
            }
        );

        /*
         * Select the object.
         */
        await workspaceAPI.viewer.setSelection(
            selectedSelector,
            "set"
        );

        /*
         * Focus camera on selected object.
         */
        if (zoomToObject) {
            await workspaceAPI.viewer.setCamera(
                selectedSelector,
                {
                    animationTime: 500
                }
            );
        }

        return runtimeId;
    }
    catch (error) {
        console.error(
            `[ParaMatic] Failed to select IFC GUID ${normalizedIfcGuid}.`,
            error
        );

        return null;
    }
}

async function getAllObjectsSelector(workspaceAPI) {
    const models = await workspaceAPI.viewer.getModels();

    const modelObjectIds = await Promise.all(
        models.map(async (m) => {
            const objects = await workspaceAPI.viewer.getObjects({
                modelObjectIds: [{ modelId: m.id }]
            });

            const runtimeIds = (objects || [])
                .flatMap((o) => o.objects || [])
                .map((o) => o.id);

            return {
                modelId: m.id,
                objectRuntimeIds: runtimeIds
            };
        })
    );

    return { modelObjectIds };
}

export async function clearViewerSelection() {
    if (!workspaceAPI) {
        return;
    }

    try {
        await workspaceAPI.viewer.setSelection(
            {
                modelObjectIds: []
            },
            "set"
        );

        /*
         * Restore full opacity for all objects.
         */
        await workspaceAPI.viewer.setObjectState(
            undefined,
            {
                opacity: 1
            }
        );
    }
    catch (error) {
        console.error(
            "[ParaMatic] Failed to clear viewer selection.",
            error
        );
    }
}

/**
 * Splits flattened Trimble objects into recognised plant assets and
 * everything else, based on the object's "Name" (falling back to
 * "NAME") property.
 *
 * @param {object[]} flattenedObjects Objects returned by getAllFlattenedObjects.
 * @returns {{ matched: object[], unmatchedRuntimeIds: Map<string, number[]> }}
 *   `unmatchedRuntimeIds` is keyed by modelId, since viewer selectors
 *   (e.g. for setObjectState) are always scoped to a single model.
 */
function partitionObjectsByAssetName(flattenedObjects) {
    const matched = [];
    const unmatchedRuntimeIds = new Map();

    for (const object of flattenedObjects) {
        const name = (object?.Name ?? object?.NAME ?? "").trim();

        if (ASSET_NAMES.has(name)) {
            matched.push(object);
            continue;
        }

        if (!unmatchedRuntimeIds.has(object.modelId)) {
            unmatchedRuntimeIds.set(object.modelId, []);
        }

        unmatchedRuntimeIds.get(object.modelId).push(object.runtimeId);
    }

    UnMatchedRuntimeIds = unmatchedRuntimeIds;

    return { matched, unmatchedRuntimeIds };
}

/**
 * Fetches and flattens a single object's properties, by modelId +
 * runtimeId, on demand. This is the JS-side counterpart to the
 * "select an object in the viewer, then click Add Asset" flow -
 * unlike getAllFlattenedObjects()/getAllLoadedObjects(), this never
 * touches any object other than the one requested, so it's safe to
 * call on click rather than only at model-load time.
 *
 * @param {string} modelId
 * @param {number} runtimeId
 * @returns {Promise<object|null>}
 */
export async function getFlattenedObjectByRuntimeId(modelId, runtimeId) {
    const viewer = getViewer();

    if (!viewer) {
        console.warn(
            "[ParaMatic] Cannot fetch object properties - the viewer is not connected."
        );

        return null;
    }

    if (!isNonEmptyString(modelId) || !Number.isInteger(runtimeId)) {
        console.warn(
            "[ParaMatic] getFlattenedObjectByRuntimeId requires a modelId " +
            "and an integer runtimeId.",
            { modelId, runtimeId }
        );

        return null;
    }

    try {
        const properties = await getObjectPropertiesInBatches(
            modelId,
            [runtimeId],
            1
        );

        if (!properties || properties.length === 0) {
            console.warn(
                `[ParaMatic] No properties found for runtime ID ${runtimeId} ` +
                `in model ${modelId}.`
            );

            return null;
        }

        const guidMap = await getIfcGuidsByRuntimeId(modelId, [runtimeId]);

        return flattenTrimbleObject(
            modelId,
            properties[0],
            guidMap.get(runtimeId) ?? null
        );
    } catch (error) {
        console.error(
            `[ParaMatic] Failed to fetch properties for runtime ID ${runtimeId} ` +
            `in model ${modelId}:`,
            error
        );

        return null;
    }
}

export async function getAllFlattenedObjects() {
    try {
        const groupedObjects = await getAllLoadedObjects();

        const flattenedGroups = await mapWithConcurrency(
            groupedObjects,
            MODEL_CONCURRENCY,
            group => flattenModelObjects(group.modelId, group.objects)
        );

        const flattened = flattenedGroups.flat();

        console.info(
            `[Trimble Objects] Returning ${flattened.length} flattened objects.`, flattened
        );

        return flattened;
    } catch (error) {
        console.error("[Trimble Objects] Failed to flatten objects:", error);
        return [];
    }
}

export async function getAllLoadedObjects() {
    const viewer = getViewer();
    if (!viewer) {
        return [];
    }

    try {
        const modelGroups = await viewer.getObjects();
        const validGroups = (modelGroups ?? [])
            .map(group => ({
                modelId: group?.modelId,
                runtimeIds: getRuntimeIds(group)
            }))
            .filter(group =>
                isNonEmptyString(group.modelId) && group.runtimeIds.length > 0
            );

        const results = await mapWithConcurrency(
            validGroups,
            MODEL_CONCURRENCY,
            async group => ({
                modelId: group.modelId,
                runtimeIds: group.runtimeIds,
                objects: await getObjectPropertiesInBatches(
                    group.modelId,
                    group.runtimeIds
                )
            })
        );

        const objectCount = results.reduce(
            (total, result) => total + result.objects.length,
            0
        );

        console.info(
            `[Trimble Objects] Retrieved ${objectCount} objects from ${results.length} model(s).`
        );

        return results;
    } catch (error) {
        console.error("[Trimble Objects] Failed to retrieve objects:", error);
        return [];
    }
}

/**
 * Applies colors to multiple viewer objects in one call.
 *
 * Expects the shape:
 * {
 *   data: {
 *     elements: [
 *       { sourceId: "<ifcGuid>", versionId: "<modelId>", color: "#E67C73" }
 *     ]
 *   }
 * }
 *
 * `color` may be given as a "#RRGGBB" / "RRGGBB" hex string, or already as
 * an { r, g, b } object - both are accepted.
 */
export async function setElementColors(payload) {
    const viewer = getViewer();
    if (!viewer) {
        console.warn("[Trimble Colors] Viewer is not connected yet.");
        return;
    }

    const elements = payload?.data?.elements ?? payload?.elements ?? [];

    if (!Array.isArray(elements) || elements.length === 0) {
        return;
    }

    const byModel = new Map();

    for (const element of elements) {
        const modelId = element?.versionId;
        const sourceId = element?.sourceId;

        if (!isNonEmptyString(modelId) || !isNonEmptyString(sourceId)) {
            console.warn(
                "[Trimble Colors] Skipping element with missing sourceId/versionId:",
                element
            );
            continue;
        }

        if (!byModel.has(modelId)) {
            byModel.set(modelId, []);
        }

        byModel.get(modelId).push(element);
    }

    await mapWithConcurrency(
        [...byModel.entries()],
        MODEL_CONCURRENCY,
        ([modelId, modelElements]) =>
            applyColorsForModel(viewer, modelId, modelElements)
    );
}

async function applyColorsForModel(viewer, modelId, elements) {
    const sourceIds = elements.map(element => element.sourceId);

    let runtimeIds;

    try {
        runtimeIds = await viewer.convertToObjectRuntimeIds(
            modelId,
            sourceIds
        );
    } catch (error) {
        console.error(
            `[Trimble Colors] Failed to resolve runtime IDs for model ${modelId}:`,
            error
        );
        return;
    }

    // Group objects by their target color so objects sharing a color are
    // sent to the viewer in a single setObjectState call.
    const byColor = new Map();

    elements.forEach((element, index) => {
        const runtimeId = runtimeIds?.[index];

        if (!Number.isInteger(runtimeId)) {
            console.warn(
                `[Trimble Colors] No runtime ID found for source ID '${element.sourceId}' in model ${modelId}.`
            );
            return;
        }

        let rgb;

        try {
            rgb = normalizeColor(element.color);
        } catch (error) {
            console.warn(
                `[Trimble Colors] Skipping '${element.sourceId}': ${error.message}`
            );
            return;
        }

        const colorKey = `${rgb.r},${rgb.g},${rgb.b}`;

        if (!byColor.has(colorKey)) {
            byColor.set(colorKey, { rgb, runtimeIds: [] });
        }

        byColor.get(colorKey).runtimeIds.push(runtimeId);
    });

    for (const { rgb, runtimeIds: idsForColor } of byColor.values()) {
        try {
            await viewer.setObjectState(
                {
                    modelObjectIds: [
                        { modelId, objectRuntimeIds: idsForColor }
                    ]
                },
                {
                    color: { r: rgb.r, g: rgb.g, b: rgb.b, a: 255 }
                }
            );
        } catch (error) {
            console.error(
                `[Trimble Colors] Failed to set color for model ${modelId}:`,
                error
            );
        }
    }
}

/**
 * Converts a hex color string (e.g. "#E67C73", "e67c73", "#fff") into
 * an { r, g, b } object with 0-255 integer channel values.
 */
function hexToRgb(hex) {
    const normalized = hex.trim().replace(/^#/, "");

    const expanded = normalized.length === 3
        ? normalized.split("").map(char => char + char).join("")
        : normalized;

    if (!/^[0-9a-fA-F]{6}$/.test(expanded)) {
        throw new Error(`Invalid hex color: "${hex}"`);
    }

    return {
        r: parseInt(expanded.slice(0, 2), 16),
        g: parseInt(expanded.slice(2, 4), 16),
        b: parseInt(expanded.slice(4, 6), 16)
    };
}

/** Accepts either a hex string or an { r, g, b } object and returns { r, g, b }. */
function normalizeColor(color) {
    if (typeof color === "string") {
        return hexToRgb(color);
    }

    if (
        color &&
        typeof color === "object" &&
        Number.isFinite(color.r) &&
        Number.isFinite(color.g) &&
        Number.isFinite(color.b)
    ) {
        return { r: color.r, g: color.g, b: color.b };
    }

    throw new TypeError(
        "color must be a hex string (e.g. \"#E67C73\") or an {r, g, b} object"
    );
}

function getRuntimeIds(modelGroup) {
    return [
        ...new Set(
            (modelGroup?.objects ?? [])
                .map(object => object?.id)
                .filter(Number.isInteger)
        )
    ];
}

async function getObjectPropertiesInBatches(
    modelId,
    runtimeIds,
    batchSize = PROPERTY_BATCH_SIZE
) {
    const viewer = getViewer();
    if (!viewer || runtimeIds.length === 0) {
        return [];
    }

    const batches = chunk(runtimeIds, batchSize);

    const batchResults = await mapWithConcurrency(
        batches,
        PROPERTY_BATCH_CONCURRENCY,
        async batch => {
            try {
                const properties = await viewer.getObjectProperties(
                    modelId,
                    batch
                );

                return Array.isArray(properties) ? properties : [];
            } catch (error) {
                console.error(
                    `[Trimble Objects] Property batch failed for model ${modelId}:`,
                    error
                );
                return [];
            }
        }
    );

    return batchResults.flat();
}

async function flattenModelObjects(modelId, objects) {
    const runtimeIds = objects
        .map(object => object?.id)
        .filter(Number.isInteger);

    const guidMap = await getIfcGuidsByRuntimeId(modelId, runtimeIds);

    return objects.map(object =>
        flattenTrimbleObject(
            modelId,
            object,
            guidMap.get(object.id) ?? null
        )
    );
}

async function getIfcGuidsByRuntimeId(
    modelId,
    runtimeIds,
    batchSize = GUID_BATCH_SIZE
) {
    const guidMap = new Map();
    const batches = chunk(runtimeIds, batchSize);

    await mapWithConcurrency(
        batches,
        GUID_BATCH_CONCURRENCY,
        batch => resolveGuidBatch(modelId, batch, guidMap)
    );

    return guidMap;
}

async function resolveGuidBatch(modelId, runtimeIds, guidMap) {
    if (runtimeIds.length === 0) {
        return;
    }

    const viewer = getViewer();
    if (!viewer) {
        return;
    }

    try {
        const ifcGuids = await viewer.convertToObjectIds(
            modelId,
            runtimeIds
        );

        runtimeIds.forEach((runtimeId, index) => {
            const ifcGuid = ifcGuids?.[index];
            if (!ifcGuid) {
                return;
            }

            guidMap.set(runtimeId, ifcGuid);
        });
    } catch (error) {
        if (runtimeIds.length === 1) {
            return;
        }

        const middle = Math.floor(runtimeIds.length / 2);

        await Promise.all([
            resolveGuidBatch(modelId, runtimeIds.slice(0, middle), guidMap),
            resolveGuidBatch(modelId, runtimeIds.slice(middle), guidMap)
        ]);
    }
}

function flattenTrimbleObject(modelId, object, ifcGuid = null) {
    const flattened = {
        modelId,
        ifcGuid,
        runtimeId: object.id,
        class: object.class ?? "Unknown",
        positionX: object.position?.x ?? 0,
        positionY: object.position?.y ?? 0,
        positionZ: object.position?.z ?? 0
    };

    for (const propertySet of object.properties ?? []) {
        for (const property of propertySet.properties ?? []) {
            if (property?.name && IFC_OBJECT_JSON_PROPERTY_NAMES.has(property.name)) {
                flattened[property.name] = property.value;
            }
        }
    }

    return flattened;
}

/** Currently unused (kept from the pre-split file) - not called anywhere. */
export function ifcGuidToUuid(ifcGuid) {
    if (!isNonEmptyString(ifcGuid)) {
        throw new Error("IFC GUID must be a non-empty string.");
    }

    const ifcCharacters =
        "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";

    let number = 0n;

    for (const character of ifcGuid) {
        const index = ifcCharacters.indexOf(character);

        if (index === -1) {
            throw new Error(`Invalid IFC GUID character: ${character}`);
        }

        number = number * 64n + BigInt(index);
    }

    const hex = number.toString(16).padStart(32, "0");

    return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20)
    ].join("-");
}

function chunk(items, size) {
    const chunks = [];

    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
    }

    return chunks;
}

async function mapWithConcurrency(items, concurrency, mapper) {
    if (items.length === 0) {
        return [];
    }

    const results = new Array(items.length);
    let nextIndex = 0;

    const workers = Array.from(
        { length: Math.min(concurrency, items.length) },
        async () => {
            while (true) {
                const currentIndex = nextIndex++;

                if (currentIndex >= items.length) {
                    return;
                }

                results[currentIndex] = await mapper(
                    items[currentIndex],
                    currentIndex
                );
            }
        }
    );

    await Promise.all(workers);
    return results;
}

function isNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
}
