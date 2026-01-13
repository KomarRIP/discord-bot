import { createHash } from "node:crypto";
function canonicalize(value) {
    if (Array.isArray(value))
        return value.map(canonicalize);
    if (value && typeof value === "object") {
        const obj = value;
        const out = {};
        for (const k of Object.keys(obj).sort())
            out[k] = canonicalize(obj[k]);
        return out;
    }
    return value;
}
export function sha256Fingerprint(value) {
    const canon = canonicalize(value);
    const json = JSON.stringify(canon);
    return createHash("sha256").update(json, "utf8").digest("hex");
}
