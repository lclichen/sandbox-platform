// 控制台页面级 zh 化补丁：页头/表头/通用按钮/加载与空态接入 useConsoleLang().t
const fs = require("fs");

// 每页：文件 -> [函数签名锚点, 替换对列表]
const zh = (en) => undefined; // placeholder to keep table readable

const FILES = {
  "web/src/pages/Containers.tsx": {
    anchor: "export function Containers() {",
    hook: "  const { t } = useConsoleLang();",
    pairs: [
      ["<h1>Containers</h1>", "<h1>{t(\"Containers\")}</h1>"],
      ["<th>ID</th>", "<th>{t(\"ID\")}</th>"],
      ["<th>Name</th>", "<th>{t(\"Name\")}</th>"],
      ["<th>Owner</th>", "<th>{t(\"Owner\")}</th>"],
      ["<th>Status</th>", "<th>{t(\"Status\")}</th>"],
      ["<th>Resources</th>", "<th>{t(\"Resources\")}</th>"],
      ["<th>Created</th>", "<th>{t(\"Created\")}</th>"],
      ["<th>Actions</th>", "<th>{t(\"Actions\")}</th>"],
      ["<option value=\"\">All statuses</option>", "<option value=\"\">{t(\"All statuses\")}</option>"],
      ["<option value=\"running\">running</option>", "<option value=\"running\">{t(\"running\")}</option>"],
      ["<option value=\"stopped\">stopped</option>", "<option value=\"stopped\">{t(\"stopped\")}</option>"],
      ["<option value=\"error\">error</option>", "<option value=\"error\">{t(\"error\")}</option>"],
      ["<option value=\"destroyed\">destroyed</option>", "<option value=\"destroyed\">{t(\"destroyed\")}</option>"],
      ["Loading…", "{t(\"Loading…\")}"],
      ["No containers.", "{t(\"No containers.\")}"],
      [">Stop</button>", ">{t(\"Stop\")}</button>"],
      [">Destroy</button>", ">{t(\"Destroy\")}</button>"],
    ],
  },
  "web/src/pages/Images.tsx": {
    anchor: "export function Images() {",
    hook: "  const { t } = useConsoleLang();",
    pairs: [
      ["<h1>Images</h1>", "<h1>{t(\"Images\")}</h1>"],
      ["<th>Name</th>", "<th>{t(\"Name\")}</th>"],
      ["<th>Display name</th>", "<th>{t(\"Display name\")}</th>"],
      ["<th>Public</th>", "<th>{t(\"Public\")}</th>"],
      ["<th>Tags</th>", "<th>{t(\"Tags\")}</th>"],
      ["<th>Default resources</th>", "<th>{t(\"Default resources\")}</th>"],
      ["<th>Actions</th>", "<th>{t(\"Actions\")}</th>"],
      ["Loading…", "{t(\"Loading…\")}"],
      ["No images.", "{t(\"No images.\")}"],
      ["+ New image", "{t(\"+ New image\")}"],
    ],
  },
  "web/src/pages/Workspaces.tsx": {
    anchor: "export function Workspaces() {",
    hook: "  const { t } = useConsoleLang();",
    pairs: [["<h1>Workspaces</h1>", "<h1>{t(\"Workspaces\")}</h1>"]],
  },
  "web/src/pages/Dashboard.tsx": {
    anchor: "export function Dashboard() {",
    hook: "  const { t } = useConsoleLang();",
    pairs: [["<h1>Dashboard</h1>", "<h1>{t(\"Dashboard\")}</h1>"]],
  },
  "web/src/pages/Users.tsx": {
    anchor: "export function Users() {",
    hook: "  const { t } = useConsoleLang();",
    pairs: [["<h1>Users</h1>", "<h1>{t(\"Users\")}</h1>"]],
  },
  "web/src/pages/Quotas.tsx": {
    anchor: "export function Quotas() {",
    hook: "  const { t } = useConsoleLang();",
    pairs: [["<h1>Resource quotas</h1>", "<h1>{t(\"Resource quotas\")}</h1>"]],
  },
  "web/src/pages/Logs.tsx": {
    anchor: "export function Logs() {",
    hook: "  const { t } = useConsoleLang();",
    pairs: [["<h1>Operation logs</h1>", "<h1>{t(\"Operation logs\")}</h1>"]],
  },
  "web/src/components/Layout.tsx": {
    anchor: "export function Layout({ children }: { children: React.ReactNode }) {",
    hook: "",
    pairs: [
      ["              My API keys", "              {t(\"My API keys\")}"],
      ["              Log out", "              {t(\"Log out\")}"],
    ],
  },
};

let total = 0;
for (const [file, { anchor, hook, pairs }] of Object.entries(FILES)) {
  let s = fs.readFileSync(file, "utf8");
  if (!s.includes(anchor)) { console.error("anchor missing:", file); continue; }
  if (hook && !s.includes("useConsoleLang")) {
    s = s.replace(anchor, anchor + "\n" + hook);
    s = s.replace("import { useState } from \"react\";", "import { useState } from \"react\";\nimport { useConsoleLang } from \"../i18n\";");
    if (!s.includes("useConsoleLang")) {
      s = s.replace(/(import \{[^}]*\} from "\.\/[^"]+";\n)/, "$1import { useConsoleLang } from \"../i18n\";\n");
    }
  }
  let ok = 0;
  for (const [a, b] of pairs) {
    if (s.includes(a)) { s = s.split(a).join(b); ok++; }
  }
  fs.writeFileSync(file, s);
  total += ok;
  console.log(file, "->", ok, "replacements");
}
console.log("total:", total);
