let access = sessionStorage.getItem("rms.access") || "";
let branch = sessionStorage.getItem("rms.branch") || "";
let refreshing;
export const setBranch = (value) => {
  branch = value;
  sessionStorage.setItem("rms.branch", value);
};
export const currentBranch = () => branch;
export const currentToken = () => access;
export function saveTokens(value) {
  access = value.accessToken;
  sessionStorage.setItem("rms.access", access);
  sessionStorage.setItem("rms.refresh", value.refreshToken);
}
export function clearTokens() {
  access = "";
  sessionStorage.removeItem("rms.access");
  sessionStorage.removeItem("rms.refresh");
}
export async function api(
  path,
  body,
  method = body === undefined ? "GET" : "POST",
  extra = {},
) {
  const headers = {
    ...(access ? { Authorization: `Bearer ${access}` } : {}),
    ...(branch ? { "X-Branch-Id": branch } : {}),
    ...extra,
  };
  if (body !== undefined) {
    headers["Idempotency-Key"] =
      extra["Idempotency-Key"] || crypto.randomUUID();
    if (!(body instanceof FormData))
      headers["Content-Type"] = "application/json";
  }
  let response = await fetch("/api/" + path, {
    method,
    headers,
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
  });
  if (
    response.status === 401 &&
    !path.startsWith("auth/") &&
    !path.startsWith("public/") &&
    sessionStorage.getItem("rms.refresh")
  ) {
    refreshing =
      refreshing ||
      fetch("/api/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          refreshToken: sessionStorage.getItem("rms.refresh"),
        }),
      })
        .then(async (r) => {
          if (!r.ok) {
            clearTokens();
            throw new Error("Please sign in again");
          }
          saveTokens(await r.json());
        })
        .finally(() => {
          refreshing = null;
        });
    await refreshing;
    headers.Authorization = `Bearer ${access}`;
    response = await fetch("/api/" + path, {
      method,
      headers,
      body:
        body === undefined
          ? undefined
          : body instanceof FormData
            ? body
            : JSON.stringify(body),
    });
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
export async function privateImage(assetId) {
  const r = await fetch(`/api/media/${assetId}`, {
    headers: { Authorization: `Bearer ${access}`, "X-Branch-Id": branch },
  });
  if (!r.ok) throw new Error("Cannot load image");
  return URL.createObjectURL(await r.blob());
}
