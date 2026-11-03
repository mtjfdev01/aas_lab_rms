import React, { useState, useEffect } from "react";
const h = React.createElement;
export default function Platform() {
  const [token, T] = useState(sessionStorage.getItem("rms.platform") || ""),
    [email, E] = useState("admin@platform.test"),
    [password, P] = useState(""),
    [tenants, D] = useState([]),
    [error, X] = useState(""),
    [support, S] = useState(null),
    [audit, A] = useState([]),
    [create, C] = useState(false),
    [form, F] = useState({}),
    [busy, B] = useState(false);
  async function request(path, body) {
    const r = await fetch("/platform-api/" + path, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const value = await r.json();
    if (!r.ok) throw new Error(value.error || "Platform request failed");
    return value;
  }
  async function refresh() {
    D(await request("tenants"));
    A(await request("audit"));
  }
  async function act(fn) {
    B(true);
    X("");
    try {
      await fn();
    } catch (e) {
      X(e.message);
    } finally {
      B(false);
    }
  }
  useEffect(() => {
    if (token) act(refresh);
  }, [token]);
  const field = (key, title, type = "text", required = true) =>
    h(
      "label",
      { key },
      title,
      h("input", {
        type,
        value: form[key] || "",
        required,
        onChange: (e) => F({ ...form, [key]: e.target.value }),
      }),
    );
  if (!token)
    return h(
      "main",
      { className: "login" },
      h(
        "form",
        {
          onSubmit: (e) => {
            e.preventDefault();
            act(async () => {
              const r = await request("login", { email, password });
              T(r.token);
              sessionStorage.setItem("rms.platform", r.token);
            });
          },
        },
        h(
          "div",
          { className: "brand" },
          "AAS",
          h("span", {}, "PLATFORM ADMINISTRATION"),
        ),
        h("h1", {}, "Platform sign in"),
        h(
          "label",
          {},
          "Administrator email",
          h("input", {
            type: "email",
            value: email,
            onChange: (e) => E(e.target.value),
            required: true,
          }),
        ),
        h(
          "label",
          {},
          "Password",
          h("input", {
            type: "password",
            value: password,
            onChange: (e) => P(e.target.value),
            required: true,
          }),
        ),
        error && h("p", { className: "error", role: "alert" }, error),
        h("button", { disabled: busy }, "Sign in"),
      ),
    );
  return h(
    "main",
    { className: "customer" },
    h(
      "header",
      { className: "topbar" },
      h(
        "div",
        {},
        h("div", { className: "eyebrow" }, "PLATFORM ADMINISTRATION"),
        h("h1", {}, "Restaurant businesses"),
      ),
      h(
        "button",
        {
          className: "secondary",
          onClick: () => {
            T("");
            sessionStorage.removeItem("rms.platform");
          },
        },
        "Sign out",
      ),
    ),
    error && h("p", { className: "error", role: "alert" }, error),
    h(
      "div",
      { className: "toolbar" },
      h(
        "button",
        { onClick: () => C(!create) },
        create ? "Close form" : "Create tenant",
      ),
      h(
        "button",
        { className: "secondary", onClick: () => act(refresh) },
        "Refresh",
      ),
    ),
    create &&
      h(
        "form",
        {
          className: "card",
          onSubmit: (e) => {
            e.preventDefault();
            act(async () => {
              await request("tenants", form);
              C(false);
              F({});
              await refresh();
            });
          },
        },
        h("h2", {}, "New restaurant business"),
        h(
          "div",
          { className: "formgrid" },
          field("name", "Business name"),
          field("branchName", "First branch name"),
          field("ownerName", "Owner name"),
          field("ownerEmail", "Owner email", "email"),
          field(
            "ownerPassword",
            "Initial owner password (12+ characters)",
            "password",
          ),
          field("reason", "Provisioning reason"),
        ),
        h("button", { disabled: busy }, "Create business"),
      ),
    h(
      "div",
      { className: "tablewrap" },
      h(
        "table",
        {},
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            ...[
              "Business",
              "State",
              "Branches",
              "Storage limit",
              "Actions",
            ].map((v) => h("th", { key: v }, v)),
          ),
        ),
        h(
          "tbody",
          {},
          ...tenants.map((t) =>
            h(
              "tr",
              { key: t.id },
              h("td", {}, t.name),
              h(
                "td",
                {},
                h("span", { className: "badge " + t.state }, t.state),
              ),
              h("td", {}, t.branch_count),
              h(
                "td",
                {},
                `${Math.round(Number(t.storage_limit) / 1048576)} MB`,
              ),
              h(
                "td",
                { className: "actions" },
                h(
                  "select",
                  {
                    "aria-label": `Subscription for ${t.name}`,
                    value: t.state,
                    disabled: busy,
                    onChange: (e) => {
                      const state = e.target.value,
                        reason = prompt(
                          "Reason for subscription change (required)",
                        );
                      if (reason)
                        act(async () => {
                          await request(`tenants/${t.id}/state`, {
                            state,
                            reason,
                          });
                          await refresh();
                        });
                    },
                  },
                  ...["trial", "active", "suspended", "expired"].map((v) =>
                    h("option", { key: v, value: v }, v),
                  ),
                ),
                h(
                  "button",
                  {
                    className: "secondary",
                    disabled: busy,
                    onClick: () => {
                      const reason = prompt(
                        "Support ticket / reason for read-only tenant access",
                      );
                      if (reason)
                        act(async () => {
                          S({
                            tenant: t.name,
                            ...(await request(`tenants/${t.id}/support`, {
                              reason,
                            })),
                          });
                          await refresh();
                        });
                    },
                  },
                  "Audited support read",
                ),
              ),
            ),
          ),
        ),
      ),
    ),
    support &&
      h(
        "section",
        { className: "card" },
        h("h2", {}, "Support: " + support.tenant),
        h(
          "p",
          { className: "muted" },
          "This read is recorded in platform audit history. Tenant staff credentials are not impersonated.",
        ),
        ...support.branches.map((b) => h("p", { key: b.id }, b.name)),
        h(
          "div",
          { className: "tablewrap" },
          h(
            "table",
            {},
            h(
              "tbody",
              {},
              ...support.orders.map((o) =>
                h(
                  "tr",
                  { key: o.id },
                  h("td", {}, "#" + o.number),
                  h("td", {}, o.source),
                  h("td", {}, o.status),
                ),
              ),
            ),
          ),
        ),
      ),
    h("h2", {}, "Platform audit"),
    h(
      "div",
      { className: "tablewrap" },
      h(
        "table",
        {},
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            ...["Time", "Action", "Reason"].map((v) => h("th", { key: v }, v)),
          ),
        ),
        h(
          "tbody",
          {},
          ...audit.map((a) =>
            h(
              "tr",
              { key: a.id },
              h("td", {}, new Date(a.created_at).toLocaleString()),
              h("td", {}, a.action),
              h("td", {}, a.reason),
            ),
          ),
        ),
      ),
    ),
  );
}
