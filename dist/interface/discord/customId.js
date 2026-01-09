export function encodeCustomId(id) {
    if (id.ns === "deploy" && id.action === "preview") {
        return `deploy:preview:v1:page=${id.page}`;
    }
    if (id.ns === "deploy" && id.action === "apply") {
        return `deploy:apply:v1:`;
    }
    if (id.ns === "deploy" && id.action === "cancel") {
        return `deploy:cancel:v1:`;
    }
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
    throw new Error(`Unsupported customId: ${JSON.stringify(id)}`);
}
export function decodeCustomId(raw) {
    const [ns, action, version, payload = ""] = raw.split(":", 4);
    if (ns !== "deploy")
        return null;
    if (version !== "v1")
        return null;
    if (action === "apply")
        return { ns: "deploy", action: "apply", version: "v1" };
    if (action === "cancel")
        return { ns: "deploy", action: "cancel", version: "v1" };
    if (action === "preview") {
        const m = payload.match(/page=(\d+)/);
        const page = m ? Number(m[1]) : 1;
        return { ns: "deploy", action: "preview", version: "v1", page: Number.isFinite(page) ? page : 1 };
    }
    return null;
}
