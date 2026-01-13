export type CustomId =
  | { ns: "deploy"; action: "preview"; version: "v1"; page: number }
  | { ns: "deploy"; action: "apply"; version: "v1" }
  | { ns: "deploy"; action: "cancel"; version: "v1" }
  | { ns: "wizard"; action: "back"; version: "v1"; sessionId: string }
  | { ns: "wizard"; action: "next"; version: "v1"; sessionId: string }
  | { ns: "wizard"; action: "preview"; version: "v1"; sessionId: string; page: number }
  | { ns: "wizard"; action: "cancel"; version: "v1"; sessionId: string }
  | { ns: "wizard"; action: "confirm"; version: "v1"; sessionId: string }
  | { ns: "wizard"; action: "edit"; version: "v1"; sessionId: string; field: string }
  | { ns: "wizard"; action: "modal"; version: "v1"; sessionId: string; field: string }
  | { ns: "intake"; action: "apply"; version: "v1" }
  | { ns: "intake"; action: "submit"; version: "v1"; applicationId: string }
  | { ns: "intake"; action: "approve"; version: "v1"; applicationId: string }
  | { ns: "intake"; action: "reject"; version: "v1"; applicationId: string }
  | { ns: "intake"; action: "cancel"; version: "v1"; applicationId: string }
  | { ns: "intake"; action: "modal"; version: "v1" };

function encodePayload(payload: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(payload)) {
    if (v === undefined) continue;
    params.set(k, String(v));
  }
  return params.toString();
}

function decodePayload(payload: string): Record<string, string> {
  const out: Record<string, string> = {};
  const params = new URLSearchParams(payload);
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

export function encodeCustomId(id: CustomId): string {
  if (id.ns === "deploy" && id.action === "preview") {
    return `deploy:preview:v1:page=${id.page}`;
  }
  if (id.ns === "deploy" && id.action === "apply") {
    return `deploy:apply:v1:`;
  }
  if (id.ns === "deploy" && id.action === "cancel") {
    return `deploy:cancel:v1:`;
  }
  if (id.ns === "wizard") {
    if (id.action === "back") return `wizard:back:v1:${encodePayload({ sessionId: id.sessionId })}`;
    if (id.action === "next") return `wizard:next:v1:${encodePayload({ sessionId: id.sessionId })}`;
    if (id.action === "preview") return `wizard:preview:v1:${encodePayload({ sessionId: id.sessionId, page: id.page })}`;
    if (id.action === "cancel") return `wizard:cancel:v1:${encodePayload({ sessionId: id.sessionId })}`;
    if (id.action === "confirm") return `wizard:confirm:v1:${encodePayload({ sessionId: id.sessionId })}`;
    if (id.action === "edit") return `wizard:edit:v1:${encodePayload({ sessionId: id.sessionId, field: id.field })}`;
    if (id.action === "modal") return `wizard:modal:v1:${encodePayload({ sessionId: id.sessionId, field: id.field })}`;
  }
  if (id.ns === "intake") {
    if (id.action === "apply") return `intake:apply:v1:`;
    if (id.action === "submit") return `intake:submit:v1:${encodePayload({ applicationId: id.applicationId })}`;
    if (id.action === "approve") return `intake:approve:v1:${encodePayload({ applicationId: id.applicationId })}`;
    if (id.action === "reject") return `intake:reject:v1:${encodePayload({ applicationId: id.applicationId })}`;
    if (id.action === "cancel") return `intake:cancel:v1:${encodePayload({ applicationId: id.applicationId })}`;
    if (id.action === "modal") return `intake:modal:v1:`;
  }
  throw new Error(`Unsupported customId: ${JSON.stringify(id)}`);
}

export function decodeCustomId(raw: string): CustomId | null {
  const [ns, action, version, payload = ""] = raw.split(":", 4);
  if (version !== "v1") return null;

  if (ns === "deploy") {
    if (action === "apply") return { ns: "deploy", action: "apply", version: "v1" };
    if (action === "cancel") return { ns: "deploy", action: "cancel", version: "v1" };
    if (action === "preview") {
      const m = payload.match(/page=(\d+)/);
      const page = m ? Number(m[1]) : 1;
      return { ns: "deploy", action: "preview", version: "v1", page: Number.isFinite(page) ? page : 1 };
    }
    return null;
  }

  if (ns === "wizard") {
    const p = decodePayload(payload);
    const sessionId = p.sessionId;
    if (!sessionId) return null;
    if (action === "back") return { ns: "wizard", action: "back", version: "v1", sessionId };
    if (action === "next") return { ns: "wizard", action: "next", version: "v1", sessionId };
    if (action === "preview") {
      const page = Number(p.page ?? "1");
      return { ns: "wizard", action: "preview", version: "v1", sessionId, page: Number.isFinite(page) ? page : 1 };
    }
    if (action === "cancel") return { ns: "wizard", action: "cancel", version: "v1", sessionId };
    if (action === "confirm") return { ns: "wizard", action: "confirm", version: "v1", sessionId };
    if (action === "edit") {
      if (!p.field) return null;
      return { ns: "wizard", action: "edit", version: "v1", sessionId, field: p.field };
    }
    if (action === "modal") {
      if (!p.field) return null;
      return { ns: "wizard", action: "modal", version: "v1", sessionId, field: p.field };
    }
    return null;
  }

  if (ns === "intake") {
    const p = decodePayload(payload);
    if (action === "apply") return { ns: "intake", action: "apply", version: "v1" };
    if (action === "submit") {
      if (!p.applicationId) return null;
      return { ns: "intake", action: "submit", version: "v1", applicationId: p.applicationId };
    }
    if (action === "approve") {
      if (!p.applicationId) return null;
      return { ns: "intake", action: "approve", version: "v1", applicationId: p.applicationId };
    }
    if (action === "reject") {
      if (!p.applicationId) return null;
      return { ns: "intake", action: "reject", version: "v1", applicationId: p.applicationId };
    }
    if (action === "cancel") {
      if (!p.applicationId) return null;
      return { ns: "intake", action: "cancel", version: "v1", applicationId: p.applicationId };
    }
    if (action === "modal") return { ns: "intake", action: "modal", version: "v1" };
    return null;
  }

  return null;
}

