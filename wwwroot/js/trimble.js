const iframe = document.getElementById("trimbleViewer");

const API = await TrimbleConnectWorkspace.connect(
    iframe,
    (event, data) => {
        console.log(event, data);
    }
);

await API.embed.setTokens({
    accessToken: "YOUR_ACCESS_TOKEN"
});

await API.embed.init3DViewer({
    projectId: "K5qUP2wGWVI",
    modelId: "Bj9R4CgdWgs"
});