import React, { useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import QRCode from "react-qr-code";
import { io } from "socket.io-client";
import {
  api,
  setBranch,
  currentBranch,
  currentToken,
  saveTokens,
  clearTokens,
  privateImage,
} from "./api.js";
import "./style.css";
import Platform from "./platform.js";
const h = React.createElement;
const money = (value, currency = "PKR") =>
  new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
    Number(value || 0) / 100,
  );
const date = (v) => (v ? new Date(v).toLocaleString() : "—");
const label = (v) =>
  String(v || "")
    .replaceAll("_", " ")
    .replaceAll(".", " ");
function Button({ children, onClick, variant = "", ...props }) {
  return h("button", { ...props, onClick, className: variant }, children);
}
function Badge({ value }) {
  return h(
    "span",
    { className: "badge " + String(value).toLowerCase() },
    label(value),
  );
}
function Empty({ text = "No records yet." }) {
  return h("div", { className: "empty" }, text);
}
function Field({
  name,
  title,
  type = "text",
  value,
  onChange,
  options,
  required = false,
  min,
  ...props
}) {
  return h(
    "label",
    { className: type === "checkbox" ? "check" : "" },
    title,
    type === "select"
      ? h(
          "select",
          {
            value: value ?? "",
            onChange: (e) => onChange(e.target.value),
            required,
            ...props,
          },
          h("option", { value: "" }, "Select…"),
          ...(options || []).map((o) =>
            h(
              "option",
              { key: o.id || o.value, value: o.id || o.value },
              o.name || o.label,
            ),
          ),
        )
      : type === "textarea"
        ? h("textarea", {
            value: value ?? "",
            onChange: (e) => onChange(e.target.value),
            required,
            ...props,
          })
        : h("input", {
            name,
            type,
            value: type === "checkbox" ? undefined : (value ?? ""),
            checked: type === "checkbox" ? !!value : undefined,
            onChange: (e) =>
              onChange(
                type === "checkbox"
                  ? e.target.checked
                  : type === "number"
                    ? e.target.value === ""
                      ? ""
                      : Number(e.target.value)
                    : e.target.value,
              ),
            required,
            min,
            ...props,
          }),
  );
}
function Modal({ title, children, onClose }) {
  const ref = useRef();
  useEffect(() => {
    ref.current.showModal();
  }, []);
  return h(
    "dialog",
    {
      ref,
      onCancel: onClose,
      onClick: (e) => {
        if (e.target === ref.current) onClose();
      },
    },
    h(
      "header",
      {},
      h("h2", {}, title),
      h(
        Button,
        { onClick: onClose, variant: "ghost", "aria-label": "Close dialog" },
        "×",
      ),
    ),
    children,
  );
}
function Form({ title, fields, initial = {}, submit, onClose }) {
  const [data, set] = useState(initial),
    [busy, B] = useState(false),
    [error, E] = useState("");
  return h(
    Modal,
    { title, onClose },
    h(
      "form",
      {
        onSubmit: async (e) => {
          e.preventDefault();
          B(true);
          E("");
          try {
            await submit(data);
            onClose();
          } catch (e) {
            E(e.message);
          } finally {
            B(false);
          }
        },
      },
      h(
        "div",
        { className: "formgrid" },
        ...fields.map((f) =>
          h(Field, {
            ...f,
            key: f.key,
            value: data[f.key],
            onChange: (v) => set({ ...data, [f.key]: v }),
          }),
        ),
      ),
      error && h("p", { role: "alert", className: "error" }, error),
      h(Button, { type: "submit", disabled: busy }, busy ? "Saving…" : "Save"),
    ),
  );
}
function DataTable({ rows, columns, actions }) {
  const [search, S] = useState(""),
    [page, P] = useState(1);
  const filtered = rows.filter(
    (r) =>
      !search || JSON.stringify(r).toLowerCase().includes(search.toLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 20)),
    current = Math.min(page, pages);
  const visible = filtered.slice((current - 1) * 20, current * 20);
  if (!rows.length) return h(Empty, {});
  return h(
    "div",
    { className: "tablewrap" },
    h(
      "div",
      { className: "tabletools" },
      h(Field, {
        title: "Filter loaded records",
        value: search,
        onChange: (v) => {
          S(v);
          P(1);
        },
        placeholder: "Search…",
      }),
      h(
        "small",
        { className: "muted" },
        `${filtered.length} matching / ${rows.length} loaded records`,
      ),
    ),
    h(
      "table",
      {},
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          ...columns.map((c) => h("th", { key: c.key }, c.title)),
          actions && h("th", {}, "Actions"),
        ),
      ),
      h(
        "tbody",
        {},
        ...visible.map((r, i) =>
          h(
            "tr",
            { key: r.id || i },
            ...columns.map((c) =>
              h(
                "td",
                { key: c.key },
                c.render ? c.render(r) : (r[c.key] ?? "—"),
              ),
            ),
            actions && h("td", { className: "actions" }, actions(r)),
          ),
        ),
      ),
    ),
    pages > 1 &&
      h(
        "div",
        { className: "pagination" },
        h(
          Button,
          {
            variant: "secondary",
            disabled: current === 1,
            onClick: () => P(current - 1),
          },
          "Previous",
        ),
        h("small", {}, `Page ${current} of ${pages}`),
        h(
          Button,
          {
            variant: "secondary",
            disabled: current === pages,
            onClick: () => P(current + 1),
          },
          "Next",
        ),
      ),
  );
}
function ErrorBox({ error }) {
  return error ? h("div", { className: "error", role: "alert" }, error) : null;
}
function useData(load, deps = []) {
  const [data, D] = useState(null),
    [error, E] = useState(""),
    [busy, B] = useState(true);
  const refresh = useCallback(async () => {
    B(true);
    try {
      D(await load());
      E("");
    } catch (e) {
      E(e.message);
    } finally {
      B(false);
    }
  }, deps);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return { data, error, busy, refresh };
}
const select = (key, title, options, required = true) => ({
  key,
  title,
  type: "select",
  options,
  required,
});
const text = (key, title, required = true) => ({ key, title, required });
const amount = (key, title, required = true) => ({
  key,
  title,
  type: "number",
  min: 0,
  required,
});
const bool = (key, title) => ({ key, title, type: "checkbox" });
function Login({ onLogin }) {
  const [email, E] = useState("owner@demo.test"),
    [password, P] = useState(""),
    [error, X] = useState(""),
    [busy, B] = useState(false);
  return h(
    "main",
    { className: "login" },
    h(
      "form",
      {
        onSubmit: async (e) => {
          e.preventDefault();
          B(true);
          try {
            saveTokens(await api("auth/login", { email, password }));
            onLogin();
          } catch (e) {
            X(e.message);
          } finally {
            B(false);
          }
        },
      },
      h(
        "div",
        { className: "brand" },
        "AAS",
        h("span", {}, "RESTAURANT OPERATIONS"),
      ),
      h("h1", {}, "Welcome back"),
      h("p", { className: "muted" }, "Sign in to your restaurant workspace."),
      h(Field, {
        title: "Email address",
        type: "email",
        value: email,
        onChange: E,
        required: true,
        autoComplete: "username",
      }),
      h(Field, {
        title: "Password",
        type: "password",
        value: password,
        onChange: P,
        required: true,
        autoComplete: "current-password",
      }),
      h(ErrorBox, { error }),
      h(Button, { disabled: busy }, busy ? "Signing in…" : "Sign in"),
    ),
  );
}
function ProductPicker({ products, onAdd, currency, tableToken }) {
  const [search, S] = useState(""),
    [chosen, C] = useState(null),
    [variant, V] = useState(""),
    [modifiers, M] = useState([]),
    [quantity, Q] = useState(1),
    [notes, N] = useState("");
  return h(
    React.Fragment,
    {},
    h(Field, {
      title: "Search menu",
      value: search,
      onChange: S,
      placeholder: "Find an item…",
    }),
    h(
      "div",
      { className: "products" },
      ...products
        .filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
        .map((p) =>
          h(
            "button",
            {
              className: "product",
              key: p.id,
              disabled: p.data.available === false || p.data.soldOut,
              onClick: () => {
                C(p);
                V(p.data.variants?.[0]?.id || "");
                M([]);
                Q(1);
                N("");
              },
            },
            p.data.imageId &&
              tableToken &&
              h("img", {
                src: `/api/media/public/${p.data.imageId}?table=${encodeURIComponent(tableToken)}&thumb=1`,
                alt: "",
              }),
            h("strong", {}, p.name),
            h("span", { className: "muted" }, p.data.description || ""),
            h(
              "b",
              {},
              money(p.data.variants?.[0]?.price ?? p.data.price, currency),
            ),
            (p.data.available === false || p.data.soldOut) &&
              h(Badge, { value: "unavailable" }),
          ),
        ),
    ),
    chosen &&
      h(
        Modal,
        { title: chosen.name, onClose: () => C(null) },
        h(
          "form",
          {
            onSubmit: (e) => {
              e.preventDefault();
              onAdd({
                productId: chosen.id,
                name: chosen.name,
                variantId: variant || undefined,
                modifiers,
                quantity,
                notes,
                estimate:
                  chosen.data.variants?.find((v) => v.id === variant)?.price ??
                  chosen.data.price,
              });
              C(null);
            },
          },
          chosen.data.variants?.length > 0 &&
            h(Field, {
              title: "Size",
              type: "select",
              value: variant,
              onChange: V,
              options: chosen.data.variants,
              required: true,
            }),
          ...(chosen.data.modifierGroups || []).map((g) =>
            h(
              "fieldset",
              { key: g.name },
              h("legend", {}, `${g.name} · choose ${g.min || 0}–${g.max}`),
              ...g.options.map((o) =>
                h(Field, {
                  key: o.id,
                  title: `${o.name} (+${money(o.price, currency)})`,
                  type: "checkbox",
                  value: modifiers.includes(o.id),
                  onChange: (v) =>
                    M(
                      v
                        ? [...modifiers, o.id]
                        : modifiers.filter((x) => x !== o.id),
                    ),
                }),
              ),
            ),
          ),
          h(Field, {
            title: "Quantity",
            type: "number",
            min: 1,
            max: 100,
            required: true,
            value: quantity,
            onChange: Q,
          }),
          h(Field, {
            title: "Preparation notes (optional)",
            type: "textarea",
            value: notes,
            onChange: N,
            maxLength: 500,
          }),
          h(Button, {}, "Add to order"),
        ),
      ),
  );
}
function Cart({ items, set, currency, submit, busy, title = "Place order" }) {
  return h(
    "section",
    { className: "card cart" },
    h("h2", {}, "Current order"),
    !items.length
      ? h(Empty, { text: "Select menu items to begin." })
      : h(
          React.Fragment,
          {},
          ...items.map((i, n) =>
            h(
              "div",
              { className: "cartline", key: n },
              h(
                "div",
                {},
                h("strong", {}, `${i.quantity} × ${i.name}`),
                h("small", {}, i.notes),
              ),
              h(
                Button,
                {
                  variant: "ghost",
                  onClick: () => set(items.filter((_, j) => j !== n)),
                  "aria-label": `Remove ${i.name}`,
                },
                "×",
              ),
            ),
          ),
          h(
            "p",
            { className: "muted" },
            "Final totals are calculated securely by the restaurant.",
          ),
          h(
            Button,
            { onClick: submit, disabled: busy },
            busy ? "Submitting…" : title,
          ),
        ),
  );
}
function Customer({ tableToken }) {
  const [customer, C] = useState(
      sessionStorage.getItem("customer." + tableToken) || "",
    ),
    [cart, S] = useState([]),
    [pin, P] = useState(""),
    [error, E] = useState(""),
    [busy, B] = useState(false),
    [orders, O] = useState([]),
    [success, X] = useState("");
  const menu = useData(
    () => api(`public/menu?token=${encodeURIComponent(tableToken)}`),
    [tableToken],
  );
  const headers = { "X-Customer-Token": customer };
  useEffect(() => {
    if (!customer) return;
    const load = () =>
      api("public/orders", undefined, "GET", headers)
        .then(O)
        .catch((e) => E(e.message));
    load();
    const timer = setInterval(load, 8000);
    return () => clearInterval(timer);
  }, [customer]);
  async function act(fn) {
    B(true);
    E("");
    try {
      await fn();
    } catch (e) {
      E(e.message);
    } finally {
      B(false);
    }
  }
  const data = menu.data;
  return h(
    "main",
    { className: "customer" },
    h(
      "header",
      { className: "customerhead" },
      h(
        "div",
        {},
        h("div", { className: "eyebrow" }, "WELCOME TO"),
        h("h1", {}, data?.branch.name || "Restaurant menu"),
        h(
          "p",
          {},
          data ? `${data.table.name} · Order from your table` : "Loading…",
        ),
      ),
      h("span", { className: "logo" }, "AAS"),
    ),
    h(ErrorBox, { error: error || menu.error }),
    success && h("p", { className: "success", role: "status" }, success),
    data &&
      !customer &&
      h(
        "section",
        { className: "card" },
        h("h2", {}, "Start your order"),
        h(
          "p",
          {},
          data.branch.requirePin
            ? "Ask your waiter for your current table PIN."
            : "Staff will confirm your submitted order. This link never shows another customer’s orders.",
        ),
        data.branch.requirePin &&
          h(Field, { title: "Table session PIN", value: pin, onChange: P }),
        h(
          Button,
          {
            disabled: busy,
            onClick: () =>
              act(async () => {
                const c = await api("public/join", { pin }, "POST", {
                  "X-Customer-Token": tableToken,
                });
                sessionStorage.setItem("customer." + tableToken, c.token);
                C(c.token);
              }),
          },
          "Continue",
        ),
      ),
    data &&
      customer &&
      h(
        React.Fragment,
        {},
        h(
          "div",
          { className: "poslayout" },
          h(ProductPicker, {
            products: data.products,
            currency: data.branch.currency,
            tableToken,
            onAdd: (i) => S([...cart, i]),
          }),
          h(Cart, {
            items: cart,
            set: S,
            currency: data.branch.currency,
            busy,
            submit: () =>
              act(async () => {
                await api(
                  "public/orders",
                  {
                    items: cart.map(
                      ({
                        productId,
                        quantity,
                        variantId,
                        modifiers,
                        notes,
                      }) => ({
                        productId,
                        quantity,
                        variantId,
                        modifiers,
                        notes,
                      }),
                    ),
                  },
                  "POST",
                  headers,
                );
                S([]);
                O(await api("public/orders", undefined, "GET", headers));
                X("Order received. Staff will confirm it shortly.");
              }),
          }),
        ),
        h(
          "div",
          { className: "toolbar" },
          h(
            Button,
            {
              variant: "secondary",
              disabled: busy,
              onClick: () =>
                act(async () => {
                  await api(
                    "public/request",
                    { type: "waiter" },
                    "POST",
                    headers,
                  );
                  X("Your waiter has been notified.");
                }),
            },
            "Call waiter",
          ),
          h(
            Button,
            {
              variant: "secondary",
              disabled: busy,
              onClick: () =>
                act(async () => {
                  await api(
                    "public/request",
                    { type: "bill" },
                    "POST",
                    headers,
                  );
                  X("Bill request sent to staff.");
                }),
            },
            "Request bill",
          ),
        ),
        h("h2", {}, "Your orders"),
        ...orders.map((o) =>
          h(
            "section",
            { className: "card", key: o.id },
            h(
              "div",
              { className: "spread" },
              h("h3", {}, `Order #${o.number}`),
              h(Badge, { value: o.status }),
            ),
            ...o.items.map((i) =>
              h(
                "p",
                { key: i.id },
                `${i.snapshot.quantity} × ${i.snapshot.name} · ${label(i.status)}`,
              ),
            ),
          ),
        ),
      ),
  );
}
function POS({ run, currency }) {
  const resources = useData(
    () => Promise.all([api("menu"), api("tables")]),
    [],
  );
  const [items, I] = useState([]),
    [table, T] = useState(""),
    [type, Y] = useState("DINE_IN"),
    [busy, B] = useState(false);
  return h(
    React.Fragment,
    {},
    h(
      "div",
      { className: "toolbar" },
      h(Field, {
        title: "Order type",
        type: "select",
        value: type,
        onChange: Y,
        options: [
          { value: "DINE_IN", label: "Dine-in" },
          { value: "TAKEAWAY", label: "Takeaway" },
        ],
      }),
      type === "DINE_IN" &&
        h(Field, {
          title: "Table",
          type: "select",
          value: table,
          onChange: T,
          options: resources.data?.[1] || [],
        }),
    ),
    h(ErrorBox, { error: resources.error }),
    resources.data &&
      h(
        "div",
        { className: "poslayout" },
        h(ProductPicker, {
          products: resources.data[0],
          currency,
          onAdd: (i) => I([...items, i]),
        }),
        h(Cart, {
          items,
          set: I,
          busy,
          currency,
          submit: async () => {
            B(true);
            const ok = await run(() =>
              api("orders", {
                tableId: table,
                type,
                items: items.map(
                  ({ productId, quantity, variantId, modifiers, notes }) => ({
                    productId,
                    quantity,
                    variantId,
                    modifiers,
                    notes,
                  }),
                ),
              }),
            );
            if (ok) I([]);
            B(false);
          },
        }),
      ),
  );
}
function OrderBoard({ version, run, can, stationMode = false }) {
  const data = useData(
    () => Promise.all([api("orders"), api("resources/station")]),
    [version],
  );
  const [filter, F] = useState("active"),
    [station, S] = useState("");
  const next = (i, o) =>
    ({
      CONFIRMED: "PREPARING",
      PREPARING: "READY",
      READY: o.type === "TAKEAWAY" ? "COMPLETED" : "SERVED",
      SERVED: "COMPLETED",
    })[i.status];
  return h(
    React.Fragment,
    {},
    h(
      "div",
      { className: "toolbar" },
      h(Field, {
        title: "Orders",
        type: "select",
        value: filter,
        onChange: F,
        options: [
          { value: "active", label: "Active orders" },
          { value: "all", label: "History" },
        ],
      }),
      h(Field, {
        title: "Station",
        type: "select",
        value: station,
        onChange: S,
        options: data.data?.[1] || [],
      }),
    ),
    h(ErrorBox, { error: data.error }),
    h(
      "div",
      { className: "ordergrid" },
      ...(data.data?.[0] || [])
        .filter(
          (o) =>
            filter === "all" || !["COMPLETED", "CANCELLED"].includes(o.status),
        )
        .filter(
          (o) => !station || o.items.some((i) => i.station_id === station),
        )
        .map((o) =>
          h(
            "section",
            { className: "card ordercard", key: o.id },
            h(
              "div",
              { className: "spread" },
              h("h2", {}, `#${o.number}`),
              h(Badge, { value: o.status }),
            ),
            h(
              "p",
              { className: "muted" },
              `${label(o.type)} · ${Math.max(0, Math.floor((Date.now() - new Date(o.created_at)) / 60000))} min · ${label(o.source)}`,
            ),
            h(
              "p",
              {},
              o.order_taker_user_id
                ? `Order taker: ${o.order_taker_name_snapshot} | Staff ID: ${o.order_taker_staff_id_snapshot}`
                : "Self-order (QR)",
            ),
            ...o.items
              .filter((i) => !station || i.station_id === station)
              .map((i) =>
                h(
                  "div",
                  { className: "ticketitem", key: i.id },
                  h(
                    "strong",
                    {},
                    `${i.snapshot.quantity} × ${i.snapshot.name}`,
                  ),
                  i.snapshot.variant && h("small", {}, i.snapshot.variant.name),
                  ...i.snapshot.modifiers.map((m) =>
                    h("small", { key: m.id }, `+ ${m.name}`),
                  ),
                  i.snapshot.notes &&
                    h("p", { className: "note" }, i.snapshot.notes),
                  h(
                    "div",
                    { className: "spread" },
                    h(Badge, { value: i.status }),
                    next(i, o) &&
                      ((["PREPARING", "READY"].includes(next(i, o)) &&
                        can("kitchen.update")) ||
                        (["SERVED", "COMPLETED"].includes(next(i, o)) &&
                          can("orders.serve"))) &&
                      h(
                        Button,
                        {
                          variant: "secondary",
                          onClick: () =>
                            run(() =>
                              api(
                                `items/${i.id}`,
                                { status: next(i, o) },
                                "PATCH",
                              ),
                            ),
                        },
                        label(next(i, o)),
                      ),
                  ),
                ),
              ),
            h(
              "div",
              { className: "toolbar" },
              o.status === "NEW" &&
                can("orders.confirm") &&
                h(
                  Button,
                  {
                    onClick: () => run(() => api(`orders/${o.id}/confirm`, {})),
                  },
                  "Confirm",
                ),
              !stationMode &&
                can("orders.cancel") &&
                o.status !== "CANCELLED" &&
                h(
                  Button,
                  {
                    variant: "danger",
                    onClick: () => {
                      const reason = prompt("Cancellation reason");
                      if (reason)
                        run(() => api(`orders/${o.id}/cancel`, { reason }));
                    },
                  },
                  "Cancel",
                ),
            ),
          ),
        ),
    ),
    !data.busy &&
      !data.data?.[0]?.length &&
      h(Empty, { text: "Orders will appear here when accepted." }),
  );
}
function Tables({ version, run, can }) {
  const data = useData(
    () =>
      Promise.all([
        api("tables"),
        api("resources/hall"),
        api("branch-staff"),
      ]).then(([tables, halls, staff]) =>
        Object.assign(tables, { halls, staff }),
      ),
    [version],
  );
  const [modal, M] = useState(null),
    [qr, Q] = useState(null);
  const fields = [
    text("name", "Table name"),
    amount("capacity", "Seats"),
    select("hallId", "Hall (optional)", data.data?.halls || [], false),
    select(
      "waiterId",
      "Assigned waiter (optional)",
      data.data?.staff || [],
      false,
    ),
  ];
  function downloadQr() {
    const svg = document.querySelector("#qr-code svg");
    const url = URL.createObjectURL(
      new Blob([new XMLSerializer().serializeToString(svg)], {
        type: "image/svg+xml",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "table-qr.svg";
    a.click();
    URL.revokeObjectURL(url);
  }
  return h(
    React.Fragment,
    {},
    can("tables.manage") &&
      h(
        Button,
        {
          onClick: () =>
            M({
              title: "Add table",
              fields,
              initial: { capacity: 4 },
              submit: (d) =>
                api("tables", {
                  ...d,
                  hallId: d.hallId || null,
                  waiterId: d.waiterId || null,
                }),
            }),
        },
        "Add table",
      ),
    h(ErrorBox, { error: data.error }),
    h(
      "div",
      { className: "tablegrid" },
      ...(data.data || []).map((t) =>
        h(
          "section",
          { className: "card tablecard", key: t.id },
          h(
            "div",
            { className: "spread" },
            h("h2", {}, t.name),
            h(Badge, { value: t.state }),
          ),
          h("p", { className: "muted" }, `${t.capacity} seats`),
          t.session_id && h("small", {}, "Active table session"),
          can("tables.manage") &&
            h(
              "div",
              { className: "toolbar" },
              h(
                Button,
                {
                  variant: "secondary",
                  onClick: () =>
                    M({
                      title: "Edit table",
                      initial: {
                        ...t,
                        hallId: t.hall_id || "",
                        waiterId: t.waiter_id || "",
                      },
                      fields: [
                        ...fields,
                        select(
                          "state",
                          "State",
                          ["available", "reserved", "cleaning", "occupied"].map(
                            (value) => ({ value, label: label(value) }),
                          ),
                        ),
                      ],
                      submit: (d) =>
                        api(
                          `tables/${t.id}`,
                          {
                            ...d,
                            hallId: d.hallId || null,
                            waiterId: d.waiterId || null,
                          },
                          "PATCH",
                        ),
                    }),
                },
                "Edit",
              ),
              h(
                Button,
                {
                  variant: "secondary",
                  onClick: () =>
                    run(async () => Q(await api(`tables/${t.id}/qr`, {}))),
                },
                "New QR",
              ),
              h(
                Button,
                {
                  variant: "secondary",
                  onClick: () =>
                    M({
                      title: "Open table session",
                      fields: [text("pin", "Optional session PIN", false)],
                      submit: (d) => api(`tables/${t.id}/session`, d),
                    }),
                },
                "Session / PIN",
              ),
              t.session_id &&
                h(
                  Button,
                  {
                    variant: "secondary",
                    onClick: () =>
                      M({
                        title: "Transfer table session",
                        fields: [
                          select(
                            "tableId",
                            "Available destination",
                            (data.data || []).filter(
                              (x) => x.state === "available",
                            ),
                          ),
                        ],
                        submit: (d) =>
                          api(`sessions/${t.session_id}/transfer`, d),
                      }),
                  },
                  "Transfer",
                ),
            ),
        ),
      ),
    ),
    modal &&
      h(Form, {
        ...modal,
        onClose: () => {
          M(null);
          run(async () => {});
        },
      }),
    qr &&
      h(
        Modal,
        { title: "Table QR code", onClose: () => Q(null) },
        h(
          "div",
          { id: "qr-code", className: "qr" },
          h(QRCode, { value: qr.url, size: 240 }),
        ),
        h("p", {}, "The previous QR link is now invalid. Keep this new copy."),
        h(
          "a",
          { href: qr.url, target: "_blank", rel: "noreferrer" },
          "Open customer menu",
        ),
        h(
          "div",
          { className: "toolbar" },
          h(Button, { onClick: downloadQr }, "Download SVG"),
          h(
            Button,
            { variant: "secondary", onClick: () => window.print() },
            "Print QR",
          ),
        ),
      ),
  );
}
const resourceTitles = {
  category: "Categories",
  product: "Products",
  override: "Branch menu",
  floor: "Floors",
  hall: "Halls",
  station: "Preparation stations",
  charge: "Taxes & charges",
  supplier: "Suppliers",
  purchase_item: "Purchase catalogue",
  printer: "Printers",
  schedule: "Staff schedule",
};
function ResourceEditor({ kind, record, options, onSave, onClose }) {
  const d = record?.data || {};
  const [form, F] = useState({
      name: record?.name || "",
      active: record?.active !== false,
      ...(["product", "override"].includes(kind)
        ? { available: d.available !== false }
        : {}),
      ...d,
    }),
    [variants, V] = useState(d.variants || []),
    [groups, G] = useState(d.modifierGroups || []),
    [busy, B] = useState(false),
    [error, E] = useState("");
  const field = (key, title, type = "text", extra = {}) =>
    h(Field, {
      key,
      title,
      type,
      value: form[key],
      onChange: (v) => F({ ...form, [key]: v }),
      ...extra,
    });
  async function save(e) {
    e.preventDefault();
    B(true);
    try {
      const { name, active, ...data } = form;
      if (kind === "product" || kind === "override") {
        if (data.price === undefined) data.price = 0;
        if (kind === "product") {
          data.variants = variants;
          data.modifierGroups = groups;
        }
      }
      if (kind === "charge" && !data.base) data.base = "items";
      await onSave({ name, active, data });
      onClose();
    } catch (e) {
      E(e.message);
    } finally {
      B(false);
    }
  }
  return h(
    Modal,
    { title: `${record ? "Edit" : "Add"} ${label(kind)}`, onClose },
    h(
      "form",
      { onSubmit: save },
      h(
        "div",
        { className: "formgrid" },
        field("name", "Name", "text", { required: true }),
        field("active", "Active", "checkbox"),
        ["product", "override"].includes(kind) &&
          h(
            React.Fragment,
            {},
            kind === "override" &&
              field("productId", "Product", "select", {
                options: options.products,
                required: true,
              }),
            field("price", "Price (minor units)", "number", {
              min: 0,
              required: true,
            }),
            field("available", "Available", "checkbox"),
            field("soldOut", "Sold out", "checkbox"),
            kind === "product" &&
              field("categoryId", "Category", "select", {
                options: options.categories,
              }),
            kind === "override" &&
              field("stationId", "Preparation station", "select", {
                options: options.stations,
                required: true,
              }),
            field("description", "Description", "textarea"),
            field("displayOrder", "Display order", "number", { min: 0 }),
            field("imageId", "Menu image reference (optional)"),
          ),
        kind === "hall" &&
          field("floorId", "Floor", "select", { options: options.floors }),
        kind === "purchase_item" && field("unit", "Unit (kg, litre, piece)"),
        kind === "supplier" &&
          h(
            React.Fragment,
            {},
            field("phone", "Phone"),
            field("email", "Email", "email"),
            field("address", "Address", "textarea"),
          ),
        kind === "charge" &&
          h(
            React.Fragment,
            {},
            field("mode", "Calculation", "select", {
              options: [
                { value: "percent", label: "Percentage (basis points)" },
                { value: "fixed", label: "Fixed (minor units)" },
              ],
              required: true,
            }),
            field("value", "Value (1000 basis points = 10%)", "number", {
              min: 0,
              required: true,
            }),
            field("kind", "Classification", "select", {
              options: [
                { value: "tax", label: "Tax" },
                { value: "service", label: "Service charge" },
                { value: "other", label: "Other charge" },
              ],
            }),
            field("base", "Calculation base", "select", {
              options: [
                { value: "items", label: "Items after discount" },
                {
                  value: "running",
                  label: "Running total including earlier charges",
                },
              ],
            }),
            field("sequence", "Sequence", "number", { min: 0 }),
            field("inclusive", "Already included in price", "checkbox"),
            field("effectiveAt", "Effective from", "datetime-local"),
          ),
        kind === "printer" &&
          h(
            React.Fragment,
            {},
            field("width", "Paper width", "select", {
              options: [
                { value: 58, label: "58 mm" },
                { value: 80, label: "80 mm" },
              ],
              required: true,
              onChange: (v) => F({ ...form, width: Number(v) }),
            }),
            field("destination", "Destination", "select", {
              options: ["bill", "kitchen", "bar"].map((value) => ({
                value,
                label: label(value),
              })),
              required: true,
            }),
            field("stationId", "Station", "select", {
              options: options.stations,
            }),
          ),
        kind === "schedule" &&
          h(
            React.Fragment,
            {},
            field("userId", "Staff", "select", {
              options: options.staff,
              required: true,
            }),
            field("startsAt", "Starts", "datetime-local", { required: true }),
            field("endsAt", "Ends", "datetime-local", { required: true }),
          ),
      ),
      kind === "product" &&
        h(
          React.Fragment,
          {},
          h("h3", {}, "Variants"),
          ...variants.map((v, i) =>
            h(
              "div",
              { className: "repeatrow", key: v.id },
              h(Field, {
                title: "Variant name",
                value: v.name,
                onChange: (name) =>
                  V(variants.map((x, j) => (j === i ? { ...x, name } : x))),
                required: true,
              }),
              h(Field, {
                title: "Price (minor units)",
                type: "number",
                value: v.price,
                onChange: (price) =>
                  V(variants.map((x, j) => (j === i ? { ...x, price } : x))),
                min: 0,
                required: true,
              }),
              h(
                Button,
                {
                  type: "button",
                  variant: "ghost",
                  onClick: () => V(variants.filter((_, j) => j !== i)),
                },
                "Remove",
              ),
            ),
          ),
          h(
            Button,
            {
              type: "button",
              variant: "secondary",
              onClick: () =>
                V([
                  ...variants,
                  { id: crypto.randomUUID(), name: "", price: 0 },
                ]),
            },
            "Add variant",
          ),
          h("h3", {}, "Modifier groups"),
          ...groups.map((g, i) => {
            const edit = (patch) =>
              G(groups.map((x, j) => (j === i ? { ...x, ...patch } : x)));
            return h(
              "fieldset",
              { key: i },
              h(Field, {
                title: "Group name",
                value: g.name,
                onChange: (name) => edit({ name }),
                required: true,
              }),
              h(
                "div",
                { className: "formgrid" },
                h(Field, {
                  title: "Minimum selections",
                  type: "number",
                  value: g.min,
                  onChange: (min) => edit({ min }),
                  min: 0,
                }),
                h(Field, {
                  title: "Maximum selections",
                  type: "number",
                  value: g.max,
                  onChange: (max) => edit({ max }),
                  min: 0,
                }),
              ),
              ...g.options.map((o, j) =>
                h(
                  "div",
                  { className: "repeatrow", key: o.id },
                  h(Field, {
                    title: "Option",
                    value: o.name,
                    onChange: (name) =>
                      edit({
                        options: g.options.map((x, k) =>
                          j === k ? { ...x, name } : x,
                        ),
                      }),
                    required: true,
                  }),
                  h(Field, {
                    title: "Extra price",
                    type: "number",
                    min: 0,
                    value: o.price,
                    onChange: (price) =>
                      edit({
                        options: g.options.map((x, k) =>
                          j === k ? { ...x, price } : x,
                        ),
                      }),
                  }),
                  h(
                    Button,
                    {
                      type: "button",
                      variant: "ghost",
                      onClick: () =>
                        edit({ options: g.options.filter((_, k) => k !== j) }),
                    },
                    "Remove",
                  ),
                ),
              ),
              h(
                Button,
                {
                  type: "button",
                  variant: "secondary",
                  onClick: () =>
                    edit({
                      options: [
                        ...g.options,
                        { id: crypto.randomUUID(), name: "", price: 0 },
                      ],
                    }),
                },
                "Add option",
              ),
              h(
                Button,
                {
                  type: "button",
                  variant: "danger",
                  onClick: () => G(groups.filter((_, j) => j !== i)),
                },
                "Remove group",
              ),
            );
          }),
          h(
            Button,
            {
              type: "button",
              variant: "secondary",
              onClick: () =>
                G([...groups, { name: "", min: 0, max: 1, options: [] }]),
            },
            "Add modifier group",
          ),
        ),
      h(ErrorBox, { error }),
      h(Button, { disabled: busy }, busy ? "Saving…" : "Save"),
    ),
  );
}
function Resources({ version, run, can, user }) {
  const kinds = Object.keys(resourceTitles).filter((k) =>
    k === "product" || k === "category"
      ? can("menu.manage")
      : k === "override"
        ? can("menu.branch")
        : ["supplier", "purchase_item"].includes(k)
          ? can("finance.manage")
          : k === "schedule"
            ? can("staff.manage")
            : k === "printer"
              ? can("printers.manage")
              : ["floor", "hall"].includes(k)
                ? can("tables.manage")
                : can("settings.manage"),
  );
  const [kind, K] = useState(kinds[0] || "product"),
    [edit, E] = useState(null),
    [image, I] = useState("");
  const data = useData(
    () =>
      Promise.all([
        api("resources/" + kind),
        api("resources/category"),
        api("resources/product"),
        api("resources/station"),
        api("resources/floor"),
        can("staff.manage") ? api("staff") : Promise.resolve([]),
      ]),
    [version, kind],
  );
  const options = {
    categories: data.data?.[1] || [],
    products: data.data?.[2] || [],
    stations: data.data?.[3] || [],
    floors: data.data?.[4] || [],
    staff: data.data?.[5] || [],
  };
  return h(
    React.Fragment,
    {},
    h(
      "div",
      { className: "toolbar" },
      h(Field, {
        title: "Manage",
        type: "select",
        value: kind,
        onChange: K,
        options: kinds.map((value) => ({
          value,
          label: resourceTitles[value],
        })),
      }),
      h(Button, { onClick: () => E({}) }, "Add " + label(kind)),
    ),
    h(ErrorBox, { error: data.error }),
    kind === "product" &&
      h(
        "section",
        { className: "card" },
        h("h3", {}, "Upload menu image"),
        h(
          "p",
          { className: "muted" },
          "JPEG, PNG or WebP, up to 5 MB. Copy the returned reference into the product.",
        ),
        h("input", {
          type: "file",
          accept: "image/jpeg,image/png,image/webp",
          "aria-label": "Menu image",
          onChange: (e) => {
            const file = e.target.files[0];
            if (file)
              run(async () => {
                const f = new FormData();
                f.append("file", file);
                f.append("public", "true");
                const r = await api("media", f);
                I(r.id);
              });
          },
        }),
        image && h("p", { className: "success" }, "Image reference: " + image),
      ),
    h(DataTable, {
      rows: data.data?.[0] || [],
      columns: [
        { key: "name", title: "Name" },
        {
          key: "active",
          title: "Status",
          render: (r) => h(Badge, { value: r.active ? "active" : "inactive" }),
        },
        {
          key: "scope",
          title: "Scope",
          render: (r) => (r.branch_id ? "This branch" : "Tenant-wide"),
        },
        {
          key: "price",
          title: "Price / value",
          render: (r) =>
            r.data.price !== undefined
              ? money(r.data.price)
              : (r.data.value ?? "—"),
        },
      ],
      actions: (r) =>
        h(Button, { variant: "secondary", onClick: () => E(r) }, "Edit"),
    }),
    edit &&
      h(ResourceEditor, {
        kind,
        record: edit.id ? edit : null,
        options,
        onSave: (d) =>
          api(
            `resources/${kind}${edit.id ? "/" + edit.id : ""}`,
            d,
            edit.id ? "PATCH" : "POST",
          ),
        onClose: () => {
          E(null);
          run(async () => {});
        },
      }),
  );
}
function GenerateBill({ sessions, currency, can, onClose, onSaved }) {
  const [sessionId, S] = useState(""),
    [type, T] = useState("fixed"),
    [value, V] = useState("0"),
    [reason, R] = useState(""),
    [busy, B] = useState(false),
    [error, E] = useState("");
  const minor = (raw) => {
    const text = String(raw).trim();
    if (!/^\d+(\.\d{1,2})?$/.test(text))
      throw new Error(
        "Enter a non-negative value with up to two decimal places.",
      );
    const [whole, fraction = ""] = text.split(".");
    const n = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
    if (!Number.isSafeInteger(n))
      throw new Error("Discount value is too large.");
    return n;
  };
  return h(
    Modal,
    { title: "Generate finalized bill", onClose },
    h(
      "form",
      {
        onSubmit: async (e) => {
          e.preventDefault();
          B(true);
          E("");
          try {
            await api("bills", {
              sessionId,
              discountType: type,
              discountValue: can("discounts.apply") ? minor(value) : 0,
              discountReason: reason,
            });
            onSaved();
            onClose();
          } catch (e) {
            E(e.message);
          } finally {
            B(false);
          }
        },
      },
      h(Field, {
        title: "Session",
        type: "select",
        value: sessionId,
        onChange: S,
        options: sessions,
        required: true,
      }),
      can("discounts.apply") &&
        h(
          "fieldset",
          {},
          h("legend", {}, "Bill discount (optional)"),
          h(Field, {
            title: "Discount type",
            type: "select",
            value: type,
            onChange: T,
            options: [
              { value: "fixed", label: "Fixed amount" },
              { value: "percent", label: "Percentage" },
            ],
            required: true,
          }),
          h(Field, {
            title:
              type === "percent"
                ? "Discount percentage (0–100)"
                : `Discount amount (${currency})`,
            value,
            onChange: V,
            inputMode: "decimal",
            required: true,
          }),
          h(Field, {
            title: "Discount note (optional)",
            value: reason,
            onChange: R,
            maxLength: 500,
          }),
          h(
            "p",
            { className: "muted" },
            "The server validates the discount before calculating charges. The final bill and its history retain the discount and approving staff.",
          ),
        ),
      h(ErrorBox, { error }),
      h(Button, { disabled: busy }, busy ? "Generating…" : "Generate bill"),
    ),
  );
}
function BillHistory({ bill, currency, version, onClose }) {
  const [page, P] = useState(1);
  const history = useData(
    () => api(`bills/${bill.id}/history?page=${page}&limit=50`),
    [bill.id, page, version],
  );
  const title = (action) =>
    ({
      "bill.created": "Bill created",
      "bill.finalized": "Bill finalized",
      "bill.settled": "Bill settled",
      "bill.voided": "Bill voided",
      "bill.voided.reason": "Void reason",
      "payment.recorded": "Payment recorded",
      "payment.verified": "Payment verified",
      "payment.rejected": "Payment rejected",
      "payment.refunded": "Refund issued",
      "receipt.queued": "Receipt queued",
      "receipt.reprint_queued": "Receipt reprint requested",
      "receipt.dispatched": "Receipt dispatched",
      "receipt.failed": "Receipt dispatch failed",
      "print.reprint.reason": "Reprint reason",
      "bill.history_imported": "Earlier bill history imported",
    })[action] || label(action);
  const summary = (event) => {
    const d = event.data;
    const parts = [];
    if (d.total !== undefined) parts.push(`Total ${money(d.total, currency)}`);
    if (d.discount !== undefined)
      parts.push(`Discount ${money(d.discount, currency)}`);
    if (d.discountRule?.type === "percent")
      parts.push(`${d.discountRule.value / 100}% discount`);
    if (d.discountRule?.reason) parts.push(d.discountRule.reason);
    if (d.amount !== undefined) parts.push(money(d.amount, currency));
    if (d.from) parts.push(`${label(d.from)} → ${label(d.to)}`);
    else if (d.status) parts.push(label(d.status));
    if (d.reason || d.note) parts.push(d.reason || d.note);
    if (d.error) parts.push(d.error);
    return parts.join(" · ");
  };
  return h(
    Modal,
    { title: `Bill #${bill.number} · History`, onClose },
    h(
      "p",
      { className: "muted" },
      "Read-only activity history. Earlier imported events retain available audit details; missing historical names are not reconstructed.",
    ),
    h(ErrorBox, { error: history.error }),
    history.busy &&
      !history.data &&
      h("p", { role: "status" }, "Loading bill history…"),
    history.data &&
      h(
        React.Fragment,
        {},
        h(
          "ol",
          { className: "bill-timeline" },
          ...history.data.events.map((event) =>
            h(
              "li",
              { key: event.id },
              h("strong", {}, title(event.action)),
              h("small", { className: "muted" }, date(event.created_at)),
              h(
                "p",
                {},
                event.actor_name_snapshot
                  ? `${event.actor_name_snapshot} | Staff ID: ${event.actor_staff_id_snapshot}`
                  : event.actor_id
                    ? "Historical staff record: " + event.actor_id
                    : "System / migration",
              ),
              h("p", {}, summary(event)),
            ),
          ),
        ),
        h(
          "div",
          { className: "pagination" },
          h(
            Button,
            {
              variant: "secondary",
              disabled: page === 1,
              onClick: () => P(page - 1),
            },
            "Earlier page",
          ),
          h("small", {}, `${history.data.total} events · Page ${page}`),
          h(
            Button,
            {
              variant: "secondary",
              disabled: page * 50 >= history.data.total,
              onClick: () => P(page + 1),
            },
            "Next page",
          ),
        ),
      ),
  );
}

function Billing({ version, run, currency, can }) {
  const data = useData(
    () =>
      Promise.all([
        api("bills"),
        api("orders"),
        can("payments.receive")
          ? api("receiving-accounts")
          : Promise.resolve([]),
      ]),
    [version],
  );
  const [modal, M] = useState(null),
    [generate, G] = useState(false),
    [history, H] = useState(null);
  const bills = data.data?.[0] || [],
    orders = data.data?.[1] || [],
    accounts = data.data?.[2] || [];
  const sessions = [
    ...new Map(
      orders
        .filter((o) => o.status !== "CANCELLED")
        .map((o) => [
          o.session_id,
          {
            id: o.session_id,
            name: `${o.type === "TAKEAWAY" ? "Takeaway" : "Dine-in"} · order #${o.number}`,
          },
        ]),
    ).values(),
  ];
  return h(
    React.Fragment,
    {},
    h(
      Button,
      {
        onClick: () => G(true),
      },
      "Generate bill",
    ),
    h(ErrorBox, { error: data.error }),
    ...bills.map((b) => {
      const paid = b.payments
        .filter((p) => p.status === "verified" && p.direction === 1)
        .reduce((n, p) => n + Number(p.amount), 0);
      const pending = b.payments
        .filter((p) => p.status === "pending")
        .reduce((n, p) => n + Number(p.amount), 0);
      return h(
        "section",
        { className: "card", key: b.id },
        h(
          "div",
          { className: "spread" },
          h("h2", {}, `Bill #${b.number}`),
          h(Badge, { value: b.status }),
        ),
        h("p", { className: "muted" }, date(b.created_at)),
        ...b.snapshot.takers.map((t, i) =>
          h(
            "p",
            { key: i },
            t.staffId
              ? `Order taker: ${t.name} | Staff ID: ${t.staffId}`
              : t.name,
          ),
        ),
        ...b.snapshot.items.map((i, n) =>
          h(
            "div",
            { className: "spread", key: n },
            h("span", {}, `${i.quantity} × ${i.name}`),
            h("span", {}, money(i.total, currency)),
          ),
        ),
        h("hr"),
        h(
          "p",
          {},
          `Subtotal ${money(b.snapshot.subtotal, currency)} · Discount ${money(b.snapshot.discount, currency)}`,
        ),
        ...b.snapshot.charges.map((c, i) =>
          h(
            "p",
            { key: i },
            `${c.name}: ${money(c.amount, currency)} ${c.inclusive ? "(included)" : ""}`,
          ),
        ),
        h(
          "div",
          { className: "spread total" },
          h("strong", {}, "Total"),
          h("strong", {}, money(b.total, currency)),
        ),
        h(
          "p",
          {},
          `Collected: ${money(paid, currency)} · Pending verification: ${money(pending, currency)} · Unallocated: ${money(Number(b.total) - paid - pending, currency)}`,
        ),
        h(
          "div",
          { className: "toolbar" },
          can("payments.receive") &&
            h(
              Button,
              {
                onClick: () =>
                  M({
                    title: "Receive payment",
                    fields: [
                      select("accountId", "Receiving account", accounts),
                      amount("amount", "Amount (minor units)"),
                      text(
                        "reference",
                        "Transaction reference (non-cash)",
                        false,
                      ),
                      amount("tendered", "Cash tendered (optional)", false),
                    ],
                    submit: (d) =>
                      api("payments", {
                        ...d,
                        billId: b.id,
                        ...(d.tendered === "" ? { tendered: undefined } : {}),
                      }),
                  }),
              },
              "Receive / split payment",
            ),
          h(
            Button,
            {
              variant: "secondary",
              onClick: () => run(() => api("print-jobs", { billId: b.id })),
            },
            "Queue receipt",
          ),
          h(Button, { variant: "secondary", onClick: () => H(b) }, "History"),
          b.status === "finalized" &&
            can("refunds.approve") &&
            h(
              Button,
              {
                variant: "danger",
                onClick: () => {
                  const reason = prompt(
                    "Reason to void this unpaid finalized bill",
                  );
                  if (reason) run(() => api(`bills/${b.id}/void`, { reason }));
                },
              },
              "Void unpaid bill",
            ),
        ),
        h(DataTable, {
          rows: b.payments,
          columns: [
            {
              key: "amount",
              title: "Payment",
              render: (p) => money(p.amount, currency),
            },
            { key: "receiver_name", title: "Receiver" },
            {
              key: "status",
              title: "Status",
              render: (p) => h(Badge, { value: p.status }),
            },
            { key: "reference", title: "Reference" },
          ],
          actions: (p) =>
            h(
              React.Fragment,
              {},
              p.status === "pending" &&
                can("payments.verify") &&
                h(
                  React.Fragment,
                  {},
                  h(
                    Button,
                    {
                      variant: "secondary",
                      onClick: () =>
                        run(() => api(`payments/${p.id}/verify`, {})),
                    },
                    "Verify",
                  ),
                  h(
                    Button,
                    {
                      variant: "danger",
                      onClick: () => {
                        const reason = prompt(
                          "Reason to reject this unverified payment",
                        );
                        if (reason)
                          run(() => api(`payments/${p.id}/reject`, { reason }));
                      },
                    },
                    "Reject",
                  ),
                ),
              p.status === "verified" &&
                p.direction === 1 &&
                can("refunds.approve") &&
                h(
                  Button,
                  {
                    variant: "danger",
                    onClick: () =>
                      M({
                        title: "Approve refund",
                        fields: [
                          amount("amount", "Refund amount (minor units)"),
                          select("accountId", "Paying account", accounts),
                          text("reason", "Reason"),
                        ],
                        submit: (d) => api(`payments/${p.id}/refund`, d),
                      }),
                  },
                  "Refund",
                ),
            ),
        }),
      );
    }),
    generate &&
      h(GenerateBill, {
        sessions,
        currency,
        can,
        onClose: () => G(false),
        onSaved: () => run(async () => {}),
      }),
    history &&
      h(BillHistory, {
        bill: history,
        currency,
        version,
        onClose: () => H(null),
      }),
    modal &&
      h(Form, {
        ...modal,
        onClose: () => {
          M(null);
          run(async () => {});
        },
      }),
  );
}
function TransferForm({ accounts, branches, onClose, onSaved }) {
  const [toBranch, T] = useState(currentBranch()),
    [targets, A] = useState(accounts),
    [form, F] = useState({}),
    [error, E] = useState(""),
    [busy, B] = useState(false);
  useEffect(() => {
    let live = true;
    api("accounts", undefined, "GET", { "X-Branch-Id": toBranch })
      .then((rows) => {
        if (live)
          A(
            rows.filter((a) =>
              ["cash", "bank", "wallet", "card"].includes(a.type),
            ),
          );
      })
      .catch((e) => E(e.message));
    return () => {
      live = false;
    };
  }, [toBranch]);
  return h(
    Modal,
    { title: "Transfer funds", onClose },
    h(
      "form",
      {
        onSubmit: async (e) => {
          e.preventDefault();
          B(true);
          try {
            await api("transfers", { ...form, toBranchId: toBranch });
            onSaved();
            onClose();
          } catch (e) {
            E(e.message);
          } finally {
            B(false);
          }
        },
      },
      h(Field, {
        title: "From account",
        type: "select",
        value: form.fromId,
        onChange: (fromId) => F({ ...form, fromId }),
        options: accounts,
        required: true,
      }),
      h(Field, {
        title: "Destination branch",
        type: "select",
        value: toBranch,
        onChange: (v) => {
          if (v) {
            T(v);
            F({ ...form, toId: "" });
          }
        },
        options: branches,
        required: true,
      }),
      h(Field, {
        title: "To account",
        type: "select",
        value: form.toId,
        onChange: (toId) => F({ ...form, toId }),
        options: targets,
        required: true,
      }),
      h(Field, {
        title: "Amount (minor units)",
        type: "number",
        min: 1,
        value: form.amount,
        onChange: (amount) => F({ ...form, amount }),
        required: true,
      }),
      h(ErrorBox, { error }),
      h(
        Button,
        { disabled: busy },
        busy ? "Transferring…" : "Transfer atomically",
      ),
    ),
  );
}
function Finance({ version, run, currency, can, user }) {
  const data = useData(
    () =>
      Promise.all([api("accounts"), api("shifts"), api("payments"), api("me")]),
    [version],
  );
  const [transfer, T] = useState(false);
  const [modal, M] = useState(null);
  const accounts = (data.data?.[0] || []).filter((a) =>
    ["cash", "bank", "wallet", "card"].includes(a.type),
  );
  return h(
    React.Fragment,
    {},
    h(
      "div",
      { className: "toolbar" },
      h(
        Button,
        {
          onClick: () =>
            M({
              title: "Add financial account",
              fields: [
                text("name", "Account name"),
                select(
                  "type",
                  "Type",
                  ["cash", "bank", "wallet", "card"].map((value) => ({
                    value,
                    label: label(value),
                  })),
                ),
                amount("opening", "Opening balance (minor units)", false),
                text("reference", "Masked reference only", false),
              ],
              initial: { opening: 0 },
              submit: (d) => api("accounts", d),
            }),
        },
        "Add account",
      ),
      h(
        Button,
        {
          variant: "secondary",
          onClick: () =>
            M({
              title: "Cash in / out",
              fields: [
                select("accountId", "Account", accounts),
                select(
                  "kind",
                  "Movement",
                  [
                    "owner_funding",
                    "owner_withdrawal",
                    "misc_receipt",
                    "misc_expense",
                  ].map((value) => ({ value, label: label(value) })),
                ),
                amount("amount", "Amount (minor units)"),
                text("reason", "Category / reason"),
                text("note", "Note (optional)", false),
              ],
              submit: (d) => api("cash", d),
            }),
        },
        "Cash in / out",
      ),
      h(Button, { variant: "secondary", onClick: () => T(true) }, "Transfer"),
    ),
    h(ErrorBox, { error: data.error }),
    h(DataTable, {
      rows: data.data?.[0] || [],
      columns: [
        { key: "name", title: "Account" },
        { key: "type", title: "Type" },
        { key: "reference", title: "Reference" },
        {
          key: "balance",
          title: "Balance",
          render: (a) => money(a.balance, currency),
        },
      ],
    }),
    h("h2", {}, "Pending payment verification"),
    h(DataTable, {
      rows: (data.data?.[2] || []).filter((p) => p.status === "pending"),
      columns: [
        { key: "kind", title: "Source" },
        { key: "reference", title: "Reference" },
        {
          key: "amount",
          title: "Amount",
          render: (p) => money(p.amount, currency),
        },
      ],
      actions: (p) =>
        can("payments.verify") &&
        h(
          React.Fragment,
          {},
          h(
            Button,
            {
              variant: "secondary",
              onClick: () => run(() => api(`payments/${p.id}/verify`, {})),
            },
            "Verify",
          ),
          h(
            Button,
            {
              variant: "danger",
              onClick: () => {
                const reason = prompt("Reason to reject payment");
                if (reason)
                  run(() => api(`payments/${p.id}/reject`, { reason }));
              },
            },
            "Reject",
          ),
        ),
    }),
    transfer &&
      h(TransferForm, {
        accounts,
        branches:
          user.role === "owner"
            ? data.data?.[3]?.branches || []
            : (data.data?.[3]?.branches || []).filter(
                (b) => b.id === currentBranch(),
              ),
        onClose: () => T(false),
        onSaved: () => run(async () => {}),
      }),
    modal &&
      h(Form, {
        ...modal,
        onClose: () => {
          M(null);
          run(async () => {});
        },
      }),
  );
}
function Documents({ version, run, currency }) {
  const data = useData(
    () =>
      Promise.all([
        api("documents"),
        api("resources/supplier"),
        api("resources/purchase_item"),
        api("accounts"),
      ]),
    [version],
  );
  const [edit, E] = useState(false),
    [kind, K] = useState("purchase"),
    [form, F] = useState({ date: new Date().toISOString().slice(0, 10) }),
    [lines, L] = useState([]),
    [modal, M] = useState(null),
    [error, X] = useState(""),
    [busy, B] = useState(false);
  const accounts = (data.data?.[3] || []).filter((a) =>
    ["cash", "bank", "wallet", "card"].includes(a.type),
  );
  const field = (key, title, type = "text", extra = {}) =>
    h(Field, {
      key,
      title,
      type,
      value: form[key],
      onChange: (v) => F({ ...form, [key]: v }),
      ...extra,
    });
  return h(
    React.Fragment,
    {},
    h(
      Button,
      {
        onClick: () => {
          E(true);
          L([]);
          F({ date: new Date().toISOString().slice(0, 10) });
        },
      },
      "Record purchase / expense",
    ),
    h(
      "p",
      { className: "muted" },
      "Purchases record supply costs and supplier liabilities. This is not inventory management.",
    ),
    h(ErrorBox, { error: data.error }),
    h(DataTable, {
      rows: data.data?.[0] || [],
      columns: [
        { key: "kind", title: "Type" },
        { key: "invoice", title: "Invoice" },
        {
          key: "created_at",
          title: "Recorded",
          render: (d) => date(d.created_at),
        },
        {
          key: "total",
          title: "Total",
          render: (d) => money(d.total, currency),
        },
        { key: "paid", title: "Paid", render: (d) => money(d.paid, currency) },
        {
          key: "returned",
          title: "Returns",
          render: (d) => money(d.returned, currency),
        },
      ],
      actions: (d) =>
        h(
          React.Fragment,
          {},
          h(
            Button,
            {
              variant: "secondary",
              onClick: () =>
                M({
                  title: "Pay document",
                  fields: [
                    select("accountId", "Paying account", accounts),
                    amount("amount", "Amount (minor units)"),
                    text("reference", "Reference (non-cash)", false),
                  ],
                  submit: (values) =>
                    api("payments", { ...values, documentId: d.id }),
                }),
            },
            "Pay",
          ),
          d.kind === "purchase" &&
            h(
              Button,
              {
                variant: "secondary",
                onClick: () =>
                  M({
                    title: "Purchase return",
                    fields: [
                      amount("amount", "Value returned (minor units)"),
                      text("reason", "Reason"),
                    ],
                    submit: (values) => api(`documents/${d.id}/return`, values),
                  }),
              },
              "Return",
            ),
          d.kind === "purchase" &&
            Number(d.paid) + Number(d.returned) > Number(d.total) &&
            h(
              Button,
              {
                variant: "secondary",
                onClick: () =>
                  M({
                    title: "Receive supplier credit refund",
                    fields: [
                      select("accountId", "Receiving account", accounts),
                      amount("amount", "Refund amount (minor units)"),
                      text("reason", "Reason"),
                      text("reference", "Reference", false),
                    ],
                    submit: (values) =>
                      api(`documents/${d.id}/supplier-refund`, values),
                  }),
              },
              "Supplier refund",
            ),
        ),
    }),
    edit &&
      h(
        Modal,
        { title: "Record purchase / expense", onClose: () => E(false) },
        h(
          "form",
          {
            onSubmit: async (e) => {
              e.preventDefault();
              B(true);
              try {
                await api("documents", { ...form, kind, lines });
                E(false);
                run(async () => {});
              } catch (e) {
                X(e.message);
              } finally {
                B(false);
              }
            },
          },
          h(Field, {
            title: "Document type",
            type: "select",
            value: kind,
            onChange: K,
            options: ["purchase", "expense"].map((value) => ({
              value,
              label: label(value),
            })),
          }),
          h(
            "div",
            { className: "formgrid" },
            field("date", "Document date", "date", { required: true }),
            kind === "purchase"
              ? field("supplierId", "Supplier", "select", {
                  options: data.data?.[1],
                  required: true,
                })
              : field("payee", "Payee", "text", { required: true }),
            kind === "purchase"
              ? field("invoice", "Supplier invoice reference")
              : field("category", "Expense category", "text", {
                  required: true,
                }),
            kind === "expense" &&
              field("amount", "Amount (minor units)", "number", {
                min: 1,
                required: true,
              }),
            field("note", "Note (optional)", "textarea"),
          ),
          kind === "purchase" &&
            h(
              React.Fragment,
              {},
              ...lines.map((l, i) => {
                const set = (patch) =>
                  L(lines.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                return h(
                  "div",
                  { className: "repeatrow", key: i },
                  h(Field, {
                    title: "Item",
                    type: "select",
                    value: l.itemId,
                    onChange: (itemId) => set({ itemId }),
                    options: data.data?.[2],
                    required: true,
                  }),
                  h(Field, {
                    title: "Quantity",
                    type: "number",
                    min: 1,
                    value: l.quantity,
                    onChange: (quantity) => set({ quantity }),
                    required: true,
                  }),
                  h(Field, {
                    title: "Unit cost (minor)",
                    type: "number",
                    min: 0,
                    value: l.cost,
                    onChange: (cost) => set({ cost }),
                    required: true,
                  }),
                  h(
                    Button,
                    {
                      type: "button",
                      variant: "ghost",
                      onClick: () => L(lines.filter((_, j) => i !== j)),
                    },
                    "Remove",
                  ),
                );
              }),
              h(
                Button,
                {
                  type: "button",
                  variant: "secondary",
                  onClick: () =>
                    L([...lines, { itemId: "", quantity: 1, cost: 0 }]),
                },
                "Add purchase line",
              ),
              h(
                "div",
                { className: "formgrid" },
                field("discount", "Discount (minor)", "number", { min: 0 }),
                field("tax", "Tax (minor)", "number", { min: 0 }),
                field("charges", "Other charges (minor)", "number", { min: 0 }),
              ),
            ),
          h(ErrorBox, { error }),
          h(
            Button,
            { disabled: busy },
            busy ? "Recording…" : "Record document",
          ),
        ),
      ),
    modal &&
      h(Form, {
        ...modal,
        onClose: () => {
          M(null);
          run(async () => {});
        },
      }),
  );
}
function Shifts({ version, run, currency, can }) {
  const data = useData(
    () =>
      Promise.all([
        api("shifts"),
        api("receiving-accounts"),
        api("branch-staff"),
      ]),
    [version],
  );
  const [modal, M] = useState(null);
  return h(
    React.Fragment,
    {},
    h(
      Button,
      {
        onClick: () =>
          M({
            title: "Open cashier shift",
            fields: [
              select(
                "accountId",
                "Cash drawer",
                (data.data?.[1] || []).filter((a) => a.type === "cash"),
              ),
              amount("opening", "Opening physical cash (minor units)"),
            ],
            submit: (d) => api("shifts", d),
          }),
      },
      "Open shift",
    ),
    h(ErrorBox, { error: data.error }),
    h(DataTable, {
      rows: data.data?.[0] || [],
      columns: [
        { key: "opened_at", title: "Opened", render: (s) => date(s.opened_at) },
        { key: "closed_at", title: "Closed", render: (s) => date(s.closed_at) },
        {
          key: "opening",
          title: "Opening",
          render: (s) => money(s.opening, currency),
        },
        {
          key: "expected",
          title: "Expected",
          render: (s) =>
            s.expected === null ? "—" : money(s.expected, currency),
        },
        {
          key: "actual",
          title: "Counted",
          render: (s) => (s.actual === null ? "—" : money(s.actual, currency)),
        },
        {
          key: "variance",
          title: "Variance",
          render: (s) =>
            s.variance === null ? "—" : money(s.variance, currency),
        },
      ],
      actions: (s) =>
        !s.closed_at
          ? h(
              Button,
              {
                variant: "secondary",
                onClick: () =>
                  M({
                    title: "Close shift",
                    fields: [
                      amount("actual", "Physical cash count (minor units)"),
                      text("note", "Variance note (optional)", false),
                    ],
                    submit: (d) => api(`shifts/${s.id}/close`, d),
                  }),
              },
              "Close",
            )
          : can("finance.manage") && !s.reviewed_by
            ? h(
                Button,
                {
                  variant: "secondary",
                  onClick: () => run(() => api(`shifts/${s.id}/review`, {})),
                },
                "Review",
              )
            : null,
    }),
    modal &&
      h(Form, {
        ...modal,
        onClose: () => {
          M(null);
          run(async () => {});
        },
      }),
  );
}
function receipt(job, width) {
  const p = job.payload;
  const root = document.getElementById("print-area");
  root.style.width = width + "mm";
  const line = (a, b) =>
    h("div", { className: "spread" }, h("span", {}, a), h("span", {}, b));
  const content = p.bill
    ? h(
        React.Fragment,
        {},
        h("h2", {}, p.bill.snapshot.branch),
        h("h3", {}, `${p.indicator} · Bill #${p.bill.number}`),
        h("p", {}, date(p.bill.created_at)),
        h("p", {}, p.bill.snapshot.tableName || ""),
        ...p.bill.snapshot.takers.map((t, i) =>
          h(
            "p",
            { key: i },
            t.staffId
              ? `Order taker: ${t.name} | Staff ID: ${t.staffId}`
              : t.name,
          ),
        ),
        ...p.bill.snapshot.items.map((i, n) =>
          h(
            "div",
            { key: n },
            line(
              `${i.quantity} × ${i.name}`,
              money(i.total, p.bill.snapshot.currency),
            ),
            i.variant && h("small", {}, i.variant.name),
            ...i.modifiers.map((m) => h("small", { key: m.id }, "+ " + m.name)),
          ),
        ),
        h("hr"),
        line(
          "Subtotal",
          money(p.bill.snapshot.subtotal, p.bill.snapshot.currency),
        ),
        line(
          "Discount",
          money(p.bill.snapshot.discount, p.bill.snapshot.currency),
        ),
        ...p.bill.snapshot.charges.map((c, i) =>
          h(
            "div",
            { key: i },
            line(
              c.name + (c.inclusive ? " (included)" : ""),
              money(c.amount, p.bill.snapshot.currency),
            ),
          ),
        ),
        line("TOTAL", money(p.bill.total, p.bill.snapshot.currency)),
        ...p.payments.map((x) =>
          h(
            "div",
            { key: x.id },
            line(
              `${x.direction === -1 ? "Refund" : "Payment"} · ${x.status}`,
              money(x.amount, p.bill.snapshot.currency),
            ),
            h(
              "small",
              {},
              `Cashier: ${x.receiver_name} | Staff ID: ${x.receiver_staff_id}`,
            ),
            x.tendered &&
              line(
                "Change",
                money(
                  Number(x.tendered) - Number(x.amount),
                  p.bill.snapshot.currency,
                ),
              ),
          ),
        ),
        line(
          "Outstanding",
          money(
            Math.max(
              0,
              Number(p.bill.total) -
                p.payments
                  .filter((x) => x.status === "verified" && x.direction === 1)
                  .reduce((n, x) => n + Number(x.amount), 0),
            ),
            p.bill.snapshot.currency,
          ),
        ),
        h("p", {}, p.bill.snapshot.footer),
      )
    : h(
        React.Fragment,
        {},
        h("h2", {}, p.branch || ""),
        h("h3", {}, `${p.indicator} · Order #${p.order.number}`),
        h("p", {}, `${p.table || ""} · ${p.station || ""}`),
        h("p", {}, date(p.order.created_at)),
        h("p", {}, p.order.type === "TAKEAWAY" ? "Takeaway" : "Dine-in"),
        h(
          "p",
          {},
          p.order.order_taker_user_id
            ? `Order taker: ${p.order.order_taker_name_snapshot} | Staff ID: ${p.order.order_taker_staff_id_snapshot}`
            : "Self-order (QR)",
        ),
        ...p.items.map((i) =>
          h(
            "div",
            { key: i.id },
            h("strong", {}, `${i.snapshot.quantity} × ${i.snapshot.name}`),
            i.snapshot.variant && h("p", {}, i.snapshot.variant.name),
            ...i.snapshot.modifiers.map((m) =>
              h("p", { key: m.id }, "+ " + m.name),
            ),
            h("p", {}, i.snapshot.notes),
          ),
        ),
      );
  const printRoot = createRoot(root);
  printRoot.render(h("article", {}, content));
  setTimeout(() => {
    window.print();
    printRoot.unmount();
  }, 150);
}
function PrintJobs({ version, run }) {
  const data = useData(() => api("print-jobs"), [version]);
  const [width, W] = useState(80);
  return h(
    React.Fragment,
    {},
    h(Field, {
      title: "Paper width",
      type: "select",
      value: width,
      onChange: (v) => W(Number(v)),
      options: [
        { value: 58, label: "58 mm" },
        { value: 80, label: "80 mm" },
      ],
    }),
    h(
      "p",
      { className: "muted" },
      "Dispatch opens your browser print dialog. It does not confirm physical printing. Inspect ambiguous failures before reprinting.",
    ),
    h(ErrorBox, { error: data.error }),
    h(DataTable, {
      rows: data.data || [],
      columns: [
        {
          key: "created_at",
          title: "Queued",
          render: (j) => date(j.created_at),
        },
        {
          key: "destination",
          title: "Destination",
          render: (j) =>
            j.destination === "bill"
              ? "Customer receipt"
              : "Preparation station",
        },
        {
          key: "state",
          title: "State",
          render: (j) => h(Badge, { value: j.state }),
        },
        { key: "attempts", title: "Attempts" },
      ],
      actions: (j) =>
        h(
          React.Fragment,
          {},
          j.state !== "dispatched" &&
            h(
              Button,
              {
                variant: "secondary",
                onClick: () =>
                  run(async () => {
                    receipt(j, j.payload.printer?.width || width);
                    await api(
                      `print-jobs/${j.id}`,
                      { state: "dispatched" },
                      "PATCH",
                    );
                  }),
              },
              "Dispatch",
            ),
          j.state !== "dispatched" &&
            h(
              Button,
              {
                variant: "danger",
                onClick: () =>
                  run(() =>
                    api(
                      `print-jobs/${j.id}`,
                      {
                        state: "failed",
                        error: "Staff reported browser dispatch failure",
                      },
                      "PATCH",
                    ),
                  ),
              },
              "Failed",
            ),
          h(
            Button,
            {
              variant: "secondary",
              onClick: () => {
                const reason = prompt("Reason for explicit reprint");
                if (reason)
                  run(() => api(`print-jobs/${j.id}/reprint`, { reason }));
              },
            },
            "Reprint",
          ),
        ),
    }),
  );
}
function Requests({ version, run }) {
  const data = useData(
    () =>
      Promise.all([api("requests"), api("orders"), api("tables")]).then(
        ([requests, orders, tables]) =>
          requests.map((r) => {
            const order = orders.find((o) => o.session_id === r.data.sessionId);
            const table = tables.find((t) => t.session_id === r.data.sessionId);
            return {
              ...r,
              tableName:
                table?.name ||
                (order?.type === "TAKEAWAY" ? "Takeaway" : "Table session"),
            };
          }),
      ),
    [version],
  );
  return h(
    React.Fragment,
    {},
    h(ErrorBox, { error: data.error }),
    h(DataTable, {
      rows: (data.data || []).filter((r) => r.active),
      columns: [
        { key: "name", title: "Request" },
        {
          key: "created_at",
          title: "Received",
          render: (r) => date(r.created_at),
        },
        { key: "session", title: "Table session", render: (r) => r.tableName },
      ],
      actions: (r) =>
        h(
          Button,
          { onClick: () => run(() => api("requests/" + r.id, {})) },
          "Resolve",
        ),
    }),
  );
}
function Reports({ version, currency }) {
  const [day, D] = useState("");
  const data = useData(
    () => api("reports" + (day ? "?date=" + day : "")),
    [version, day],
  );
  const r = data.data;
  return h(
    React.Fragment,
    {},
    h(Field, {
      title: "Business date (blank for all)",
      type: "date",
      value: day,
      onChange: D,
    }),
    h(ErrorBox, { error: data.error }),
    r &&
      h(
        React.Fragment,
        {},
        h(
          "div",
          { className: "stats" },
          ...[
            "sales",
            "collections",
            "refunds",
            "netSales",
            "purchases",
            "expenses",
          ].map((k) =>
            h(
              "section",
              { className: "card stat", key: k },
              h("small", {}, label(k)),
              h("strong", {}, money(r[k], currency)),
            ),
          ),
        ),
        h(
          "p",
          { className: "muted" },
          r.basis +
            ` Timezone: ${r.timezone}; business day starts ${r.cutoff}:00. Maximum 5,000 recent documents per view.`,
        ),
        h("h2", {}, "Top-selling items (all time)"),
        h(DataTable, {
          rows: r.topItems,
          columns: [
            { key: "name", title: "Item" },
            { key: "quantity", title: "Quantity" },
            {
              key: "total",
              title: "Sales",
              render: (x) => money(x.total, currency),
            },
          ],
        }),
        h("h2", {}, "Collections by user and account"),
        h(DataTable, {
          rows: r.payments,
          columns: [
            { key: "received_by", title: "Staff record" },
            { key: "account_id", title: "Account" },
            { key: "kind", title: "Source" },
            { key: "status", title: "Verification" },
            {
              key: "amount",
              title: "Amount",
              render: (x) => money(x.amount, currency),
            },
          ],
        }),
        h("h2", {}, "Order takers and sources"),
        h(DataTable, {
          rows: r.orders,
          columns: [
            { key: "number", title: "Order" },
            { key: "source", title: "Source" },
            { key: "order_taker_name_snapshot", title: "Order taker" },
            { key: "order_taker_staff_id_snapshot", title: "Staff ID" },
            { key: "status", title: "Status" },
          ],
        }),
      ),
  );
}
function Administration({ version, run, user }) {
  const data = useData(
    () => Promise.all([api("staff"), api("branches"), api("access-options")]),
    [version],
  );
  const [edit, E] = useState(null),
    [branchModal, B] = useState(false),
    [error, X] = useState("");
  return h(
    React.Fragment,
    {},
    h(
      "div",
      { className: "toolbar" },
      h(
        Button,
        {
          onClick: () =>
            E({
              name: "",
              staffId: "",
              email: "",
              password: "",
              role: "waiter",
              branches: [],
              permissions: data.data?.[2]?.roles.waiter || [],
              stationIds: [],
              active: true,
            }),
        },
        "Add staff",
      ),
      h(Button, { variant: "secondary", onClick: () => B(true) }, "Add branch"),
    ),
    h(ErrorBox, { error: data.error }),
    h(DataTable, {
      rows: data.data?.[0] || [],
      columns: [
        { key: "name", title: "Name" },
        { key: "staff_id", title: "Stable staff ID" },
        { key: "role", title: "Role" },
        {
          key: "active",
          title: "Status",
          render: (u) => h(Badge, { value: u.active ? "active" : "inactive" }),
        },
      ],
      actions: (u) =>
        h(
          Button,
          {
            variant: "secondary",
            disabled: u.id === user.id,
            onClick: () =>
              E({ ...u, staffId: u.staff_id, stationIds: u.station_ids }),
          },
          u.id === user.id ? "Current user" : "Edit",
        ),
    }),
    edit &&
      h(
        Modal,
        { title: edit.id ? "Edit staff" : "Add staff", onClose: () => E(null) },
        h(
          "form",
          {
            onSubmit: async (e) => {
              e.preventDefault();
              try {
                await api(
                  "staff" + (edit.id ? "/" + edit.id : ""),
                  {
                    ...edit,
                    stationIds: edit.stationIds.filter((v) =>
                      (data.data?.[2]?.stations || []).some(
                        (station) =>
                          station.id === v &&
                          edit.branches.includes(station.branch_id),
                      ),
                    ),
                  },
                  edit.id ? "PATCH" : "POST",
                );
                E(null);
                run(async () => {});
              } catch (e) {
                X(e.message);
              }
            },
          },
          h(
            "div",
            { className: "formgrid" },
            ...[
              text("name", "Name"),
              text("staffId", "Stable staff ID"),
              ...(!edit.id
                ? [
                    {
                      key: "email",
                      title: "Email",
                      type: "email",
                      required: true,
                    },
                    {
                      key: "password",
                      title: "Initial password (12+ characters)",
                      type: "password",
                      required: true,
                    },
                  ]
                : [
                    {
                      key: "password",
                      title: "Reset password (optional, 12+ characters)",
                      type: "password",
                    },
                  ]),
              select(
                "role",
                "Role",
                ["owner", "manager", "cashier", "waiter", "kitchen", "bar"].map(
                  (value) => ({ value, label: label(value) }),
                ),
              ),
              bool("active", "Active"),
            ].map((f) =>
              h(Field, {
                ...f,
                key: f.key,
                value: edit[f.key],
                disabled: f.key === "staffId" && !!edit.id,
                onChange: (v) =>
                  E({
                    ...edit,
                    [f.key]: v,
                    ...(f.key === "role"
                      ? { permissions: data.data?.[2]?.roles[v] || [] }
                      : {}),
                  }),
              }),
            ),
          ),
          h(
            "fieldset",
            {},
            h("legend", {}, "Branch assignments"),
            ...(data.data?.[1] || []).map((b) =>
              h(Field, {
                key: b.id,
                title: b.name,
                type: "checkbox",
                value: edit.branches.includes(b.id),
                onChange: (v) =>
                  E({
                    ...edit,
                    branches: v
                      ? [...edit.branches, b.id]
                      : edit.branches.filter((x) => x !== b.id),
                  }),
              }),
            ),
          ),
          h(
            "fieldset",
            {},
            h("legend", {}, "Permissions"),
            h(
              "div",
              { className: "formgrid" },
              ...(data.data?.[2]?.permissions || []).map((p) =>
                h(Field, {
                  key: p,
                  title: label(p),
                  type: "checkbox",
                  value: edit.permissions.includes(p),
                  onChange: (v) =>
                    E({
                      ...edit,
                      permissions: v
                        ? [...edit.permissions, p]
                        : edit.permissions.filter((x) => x !== p),
                    }),
                }),
              ),
            ),
          ),
          h(
            "fieldset",
            {},
            h("legend", {}, "Preparation stations"),
            ...(data.data?.[2]?.stations || [])
              .filter((station) => edit.branches.includes(station.branch_id))
              .map((station) =>
                h(Field, {
                  key: station.id,
                  title:
                    station.name +
                    " · " +
                    (data.data?.[1]?.find((b) => b.id === station.branch_id)
                      ?.name || ""),
                  type: "checkbox",
                  value: edit.stationIds.includes(station.id),
                  onChange: (v) =>
                    E({
                      ...edit,
                      stationIds: v
                        ? [...edit.stationIds, station.id]
                        : edit.stationIds.filter((x) => x !== station.id),
                    }),
                }),
              ),
          ),
          h(ErrorBox, { error }),
          h(Button, {}, "Save staff"),
        ),
      ),
    branchModal &&
      h(Form, {
        title: "Add branch",
        fields: [
          text("name", "Branch name"),
          text("currency", "Currency (ISO code)"),
          text("timezone", "Timezone"),
          amount("cutoff", "Business day starts at hour"),
        ],
        initial: { currency: "PKR", timezone: "Asia/Karachi", cutoff: 0 },
        submit: (d) => api("branches", d),
        onClose: () => {
          B(false);
          run(async () => {});
        },
      }),
  );
}
function Settings({ version, run }) {
  const data = useData(() => api("settings"), [version]);
  const [form, F] = useState(null);
  useEffect(() => {
    if (data.data)
      F({
        ...data.data.settings,
        timezone: data.data.timezone,
        cutoff: data.data.cutoff,
      });
  }, [data.data]);
  return h(
    React.Fragment,
    {},
    h(ErrorBox, { error: data.error }),
    form &&
      h(
        "form",
        {
          className: "card",
          onSubmit: (e) => {
            e.preventDefault();
            run(() => api("settings", form));
          },
        },
        ...[
          bool("requirePin", "Require current table-session PIN for QR access"),
          bool(
            "requireReference",
            "Require reference for manual non-cash payment",
          ),
          bool(
            "verifyNonCash",
            "Require verification before posting non-cash payment",
          ),
          text("timezone", "Branch timezone"),
          amount("cutoff", "Business day cutoff hour"),
          text("receiptFooter", "Receipt footer", false),
        ].map((f) =>
          h(Field, {
            ...f,
            key: f.key,
            value: form[f.key],
            onChange: (v) => F({ ...form, [f.key]: v }),
          }),
        ),
        h(Button, {}, "Save branch settings"),
      ),
  );
}
function Dashboard({ version, currency, can }) {
  const data = useData(
    () =>
      Promise.all([
        api("orders"),
        api("tables"),
        can("requests.manage") ? api("requests") : Promise.resolve([]),
      ]),
    [version],
  );
  const orders = data.data?.[0] || [],
    tables = data.data?.[1] || [];
  return h(
    React.Fragment,
    {},
    h(
      "section",
      { className: "welcome" },
      h(
        "div",
        {},
        h("div", { className: "eyebrow" }, "YOUR FLOOR, IN FOCUS"),
        h("h2", {}, "Ready for the next service."),
        h("p", {}, "Orders, people and accounts. One connected workspace."),
      ),
      h("div", { className: "welcomeicon" }, "◉"),
    ),
    h(ErrorBox, { error: data.error }),
    h(
      "div",
      { className: "stats" },
      ...[
        [
          "Active orders",
          orders.filter((o) => !["COMPLETED", "CANCELLED"].includes(o.status))
            .length,
        ],
        [
          "Occupied tables",
          tables.filter((t) => t.state === "occupied").length,
        ],
        ["Ready orders", orders.filter((o) => o.status === "READY").length],
        [
          "Service requests",
          (data.data?.[2] || []).filter((r) => r.active).length,
        ],
      ].map(([name, value]) =>
        h(
          "section",
          { className: "card stat", key: name },
          h("small", {}, name),
          h("strong", {}, value),
        ),
      ),
    ),
    h("h2", {}, "Recent activity"),
    h(DataTable, {
      rows: orders.slice(0, 8),
      columns: [
        { key: "number", title: "Order", render: (o) => "#" + o.number },
        { key: "source", title: "Source", render: (o) => label(o.source) },
        {
          key: "order_taker_name_snapshot",
          title: "Order taker",
          render: (o) => o.order_taker_name_snapshot || "Self-order (QR)",
        },
        {
          key: "status",
          title: "Status",
          render: (o) => h(Badge, { value: o.status }),
        },
        { key: "created_at", title: "Time", render: (o) => date(o.created_at) },
      ],
    }),
  );
}
function StaffApp() {
  const [signed, S] = useState(!!currentToken()),
    [me, M] = useState(null),
    [page, P] = useState("Overview"),
    [version, V] = useState(0),
    [error, E] = useState(""),
    [notice, N] = useState(""),
    [busy, B] = useState(0);
  const branch = currentBranch();
  const noticeTimer = useRef();
  const run = async (fn) => {
    E("");
    B((x) => x + 1);
    try {
      await fn();
      V((x) => x + 1);
      N("Saved successfully");
      clearTimeout(noticeTimer.current);
      noticeTimer.current = setTimeout(() => N(""), 4000);
      return true;
    } catch (e) {
      E(e.message);
      return false;
    } finally {
      B((x) => x - 1);
    }
  };
  useEffect(() => {
    if (!signed) return;
    api("me")
      .then((data) => {
        M(data);
        if (
          !currentBranch() ||
          !data.branches.some((b) => b.id === currentBranch())
        ) {
          setBranch(data.branches[0]?.id || "");
          V((v) => v + 1);
        }
      })
      .catch((e) => {
        E(e.message);
        if (!currentToken()) S(false);
      });
  }, [signed, version]);
  useEffect(() => {
    if (!signed || !branch) return;
    let timer, reconnectTimer;
    const socket = io({
      auth: (callback) => callback({ token: currentToken(), branchId: branch }),
    });
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => V((x) => x + 1), 250);
    };
    socket.on("refresh", refresh);
    socket.on("connect", refresh);
    socket.on("disconnect", (reason) => {
      if (reason === "io server disconnect")
        reconnectTimer = setTimeout(() => socket.connect(), 2000);
    });
    const poll = setInterval(() => V((x) => x + 1), 15000);
    return () => {
      socket.disconnect();
      clearTimeout(timer);
      clearTimeout(reconnectTimer);
      clearInterval(poll);
    };
  }, [signed, branch]);
  if (!signed) return h(Login, { onLogin: () => S(true) });
  if (!me)
    return h(
      "main",
      { className: "login" },
      h(
        "div",
        {},
        h("h2", {}, "Opening your workspace…"),
        h(ErrorBox, { error }),
        h(
          Button,
          {
            onClick: () => {
              clearTokens();
              S(false);
            },
          },
          "Back to sign in",
        ),
      ),
    );
  const user = me.user,
    can = (p) => user.permissions.includes(p),
    currency =
      me.branches.find((b) => b.id === currentBranch())?.currency || "PKR";
  const pages = [
    ["Overview", "orders.view", "◈"],
    ["New order", "orders.take", "＋"],
    ["Orders", "orders.view", "▤"],
    ["Kitchen & bar", "kitchen.update", "◷"],
    ["Tables & QR", "tables.manage", "▦"],
    ["Waiter requests", "requests.manage", "♧"],
    ["Billing", "bills.generate", "▣"],
    ["Menu & setup", null, "◇"],
    ["Accounts", "finance.manage", "◎"],
    ["Purchases & expenses", "finance.manage", "↗"],
    ["Cashier shifts", "shifts.manage", "◴"],
    ["Print queue", "orders.view", "▥"],
    ["Reports", "reports.view", "▧"],
    ...(user.role === "owner"
      ? [["Staff & branches", "staff.manage", "♙"]]
      : []),
    ["Settings", "settings.manage", "⚙"],
  ].filter(([, p]) => !p || can(p));
  const props = { version, run, currency, can, user };
  const view =
    {
      Overview: Dashboard,
      "New order": POS,
      Orders: OrderBoard,
      "Kitchen & bar": OrderBoard,
      "Tables & QR": Tables,
      "Waiter requests": Requests,
      Billing: Billing,
      "Menu & setup": Resources,
      Accounts: Finance,
      "Purchases & expenses": Documents,
      "Cashier shifts": Shifts,
      "Print queue": PrintJobs,
      Reports: Reports,
      "Staff & branches": Administration,
      Settings: Settings,
    }[page] || Dashboard;
  return h(
    "div",
    { className: "shell" },
    h(
      "aside",
      { className: "sidebar" },
      h(
        "div",
        { className: "brand" },
        "AAS",
        h("span", {}, "RESTAURANT OPERATIONS"),
      ),
      h(
        "div",
        { className: "tenant" },
        h("small", {}, "WORKSPACE"),
        h("strong", {}, me.tenant.name),
        h(Badge, { value: me.tenant.state }),
      ),
      h(
        "nav",
        { "aria-label": "Main navigation" },
        ...pages.map(([name, , icon]) =>
          h(
            "button",
            {
              key: name,
              className: page === name ? "selected" : "",
              onClick: () => {
                P(name);
                E("");
              },
            },
            h("span", { "aria-hidden": true }, icon),
            name,
          ),
        ),
      ),
      h(
        "div",
        { className: "profile" },
        h("strong", {}, user.name),
        h("small", {}, `${user.staff_id} · ${label(user.role)}`),
        h(
          Button,
          {
            variant: "ghost",
            onClick: async () => {
              try {
                await api("logout", {});
              } catch {}
              clearTokens();
              S(false);
              M(null);
            },
          },
          "Sign out",
        ),
      ),
    ),
    h(
      "main",
      { className: "workspace" },
      h(
        "header",
        { className: "topbar" },
        h(
          "div",
          {},
          h("div", { className: "eyebrow" }, "OPERATIONS"),
          h("h1", {}, page),
        ),
        h(
          "div",
          { className: "branchpicker" },
          h("span", { className: "live" }, "● Live workspace"),
          h(Field, {
            title: "Branch",
            type: "select",
            value: currentBranch(),
            options: me.branches,
            onChange: (v) => {
              if (v) {
                setBranch(v);
                V((x) => x + 1);
              }
            },
          }),
        ),
      ),
      h(
        "div",
        { className: "content", key: currentBranch() },
        h(
          "div",
          { "aria-live": "polite" },
          busy > 0 && h("div", { className: "loadingbar" }, "Saving…"),
          notice && h("div", { className: "toast" }, notice),
        ),
        h(ErrorBox, { error }),
        h(view, { ...props, stationMode: page === "Kitchen & bar" }),
      ),
    ),
    h("div", { id: "print-area" }),
  );
}
const params = new URLSearchParams(location.search),
  tableToken = params.get("table");
createRoot(document.getElementById("root")).render(
  params.has("platform")
    ? h(Platform, {})
    : tableToken
      ? h(Customer, { tableToken })
      : h(StaffApp, {}),
);
