const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

function activate(context) {
    const disposable = vscode.commands.registerCommand(
        "extension.addEndpointComment",
        async () => {
            const files = await vscode.workspace.findFiles("**/*.java");
            for (const file of files) {
                const doc = await vscode.workspace.openTextDocument(file);
                const text = doc.getText();
                if (!text.includes("@Controller") && !text.includes("@RestController")) continue;
                await processControllerDocument(doc);
            }
            vscode.window.showInformationMessage("Comentarios actualizados en todos los controladores del workspace.");
        }
    );
    context.subscriptions.push(disposable);
}

// ================
//  PUERTO SPRING
// ================
async function detectSpringPortFromProperties() {
    const ws = vscode.workspace.workspaceFolders;
    if (!ws) return null;
    const root = ws[0].uri.fsPath;
    const p = path.join(root, "src", "main", "resources", "application.properties");
    if (!fs.existsSync(p)) return null;
    const content = fs.readFileSync(p, "utf8");
    const m = content.match(/^\s*server\.port\s*=\s*(\d+)\s*$/m);
    return m ? m[1] : null;
}
async function detectSpringPortFromYaml() {
    const ws = vscode.workspace.workspaceFolders;
    if (!ws) return null;
    const root = ws[0].uri.fsPath;
    const candidates = [
        path.join(root, "src", "main", "resources", "application.yml"),
        path.join(root, "src", "main", "resources", "application.yaml")
    ];
    for (const p of candidates) {
        if (!fs.existsSync(p)) continue;
        const content = fs.readFileSync(p, "utf8");
        // muy simple pero efectivo para el caso común
        const m = content.match(/^\s*server:\s*\n\s*port:\s*(\d+)\s*$/m);
        if (m) return m[1];
    }
    return null;
}
async function getServerPort() {
    return (await detectSpringPortFromProperties()) ||
        (await detectSpringPortFromYaml()) ||
        "8080";
}

// ===========================
//  PROCESAR UN DOCUMENTO JAVA
// ===========================
async function processControllerDocument(document) {
    // 1) Recolectar todo lo necesario SIN editar el documento
    const fullText = document.getText();
    const lines = fullText.split(/\r?\n/);

    // baseUrl (con puerto autodetectado)
    const cfg = vscode.workspace.getConfiguration("springEndpointComments");
    let baseUrl = cfg.get("baseUrl") || "https://localhost:8080";
    const port = await getServerPort();
    baseUrl = baseUrl.replace(/:\d+/, ":" + port);

    // base path de @RequestMapping de la clase
    const classBasePath = detectClassBasePath(fullText);

    // encontrar todas las anotaciones de método
    const endpoints = findEndpointAnnotations(fullText);

    // Para cada anotación, construir:
    // - bloque de comentarios a insertar
    // - líneas consecutivas anteriores (comentarios viejos) para borrar
    const insertOps = []; // { line: number, text: string }
    const deleteRanges = []; // vscode.Range[]
    for (const ep of endpoints) {
        // Saltar @RequestMapping de clase (todo lo anterior a "class ")
        if (ep.kind === "RequestMapping" && ep.index < fullText.indexOf("class ")) continue;

        const line = document.positionAt(ep.index).line;
        const indent = getIndentOfLine(lines[line]);

        const methodSig = extractMethodSignature(document, line);
        const pathVars = extractPathVariables(methodSig);
        const reqParams = extractRequestParams(methodSig);
        const methodPaths = extractPathsFromParams(ep.params);
        const httpMethods = extractHttpMethods(ep.kind, ep.params);

        // construir bloque de comentarios MULTILÍNEA para esta anotación
        const commentLines = [];
        for (const http of httpMethods) {
            for (const p of methodPaths) {
                const prettyPath = buildBeautifiedPath(p, pathVars);
                let url = buildFullUrl(baseUrl, classBasePath, prettyPath);
                const q = buildQueryParams(reqParams);
                if (q) url += "?" + q;
                commentLines.push(`${indent}// ${http} ${url}`);
            }
        }
        const commentBlock = commentLines.length ? (commentLines.join("\n") + "\n") : "";

        // calcular qué comentarios viejos borrar justo encima
        const oldRanges = collectOldEndpointCommentsAbove(document, lines, line);
        deleteRanges.push(...oldRanges);

        if (commentBlock) {
            insertOps.push({ line, text: commentBlock, indent });
        }
    }

    if (insertOps.length === 0 && deleteRanges.length === 0) return;

    // 2) Aplicar cambios en UNA sola edición, sin solapes:
    //    - primero BORRAR (de abajo hacia arriba)
    //    - después INSERTAR (de abajo hacia arriba, al inicio de línea)
    const editor = await vscode.window.showTextDocument(document, { preview: false });

    await editor.edit(builder => {
        // borrar
        deleteRanges
            .sort((a, b) => b.start.line - a.start.line)
            .forEach(r => builder.delete(r));

        // insertar
        insertOps
            .sort((a, b) => b.line - a.line)
            .forEach(op => {
                const pos = new vscode.Position(op.line, 0);
                builder.insert(pos, op.text);
            });
    });

    await document.save();
}

// ---------------------------
//  DETECCIÓN / PARSEO LIGERO
// ---------------------------
function detectClassBasePath(text) {
    // busca @RequestMapping(...) antes de la palabra "class"
    const classIdx = text.indexOf("class ");
    if (classIdx < 0) return "";

    const regex = /@RequestMapping\s*\(\s*([^)]*)\)/g;
    let m;
    let base = "";
    while ((m = regex.exec(text)) !== null) {
        if (m.index < classIdx) {
            const params = m[1].trim();
            const named = params.match(/(path|value)\s*=\s*(\{[^}]*\}|".*?")/);
            if (named) {
                base = extractPaths(named[2])[0] || "";
            } else {
                const simple = params.match(/"(.*?)"/);
                if (simple) base = simple[1];
            }
        }
    }
    return base;
}

function findEndpointAnnotations(text) {
    const regex = /@(GetMapping|PostMapping|PutMapping|DeleteMapping|RequestMapping)\s*\(([^)]*)\)/g;
    const list = [];
    let m;
    while ((m = regex.exec(text)) !== null) {
        list.push({ kind: m[1], params: m[2], index: m.index });
    }
    return list;
}

function extractMethodSignature(document, startLine) {
    // captura desde la línea de la anotación hasta que abre '{' tras la firma
    let sig = "";
    let seenAccess = false; // public/private/protected
    for (let ln = startLine; ln < document.lineCount; ln++) {
        const line = document.lineAt(ln).text;
        sig += line + "\n";
        if (!seenAccess && /\b(public|private|protected)\b/.test(line)) {
            seenAccess = true;
        }
        if (seenAccess && line.includes("{")) break;
    }
    return sig;
}

function extractPathVariables(sig) {
    // @PathVariable("id") Long id
    const re = /@PathVariable\s*(?:\(\s*["']?(\w+)["']?\s*\))?\s+([\w<>]+)/g;
    const out = [];
    let m;
    while ((m = re.exec(sig)) !== null) {
        out.push({ name: m[1], type: m[2] });
    }
    return out;
}

function extractRequestParams(sig) {
    // Tolera final/annotations/genéricos simples
    const re = /@RequestParam(?:\(([^)]*)\))?\s+(?:final\s+)?(?:@[A-Za-z0-9_.]+(?:\([^)]*\))?\s+)*([\w<>]+)\s+(\w+)/g;
    const out = [];
    let m;
    while ((m = re.exec(sig)) !== null) {
        const content = m[1] || "";
        const type = m[2].trim();
        const paramName = m[3].trim();
        let name = null;

        // @RequestParam("dni")
        let mm = content.match(/["']\s*([\w-]+)\s*["']/);
        if (mm) name = mm[1];
        // @RequestParam(name="dni")
        mm = content.match(/\bname\s*=\s*["']\s*([\w-]+)\s*["']/);
        if (mm) name = mm[1];
        // @RequestParam(value="dni")
        mm = content.match(/\bvalue\s*=\s*["']\s*([\w-]+)\s*["']/);
        if (mm) name = mm[1];

        out.push({ name: name || paramName, type });
    }
    return out;
}

function extractPaths(raw) {
    if (!raw) return [""];
    raw = raw.trim();
    if (raw.startsWith("{")) {
        return raw
            .slice(1, -1)
            .split(",")
            .map(s => s.trim().replace(/^"(.*)"$/, "$1"));
    }
    const m = raw.match(/^"(.*)"$/);
    return [m ? m[1] : raw.replace(/"/g, "")];
}

function extractPathsFromParams(params) {
    const m = params.match(/(path|value)\s*=\s*(\{[^}]*\}|".*?")/);
    if (m) return extractPaths(m[2]);
    const simple = params.match(/"(.*?)"/);
    return simple ? [simple[1]] : [""];
}

function extractHttpMethods(kind, params) {
    if (kind !== "RequestMapping") return [kind.replace("Mapping", "").toUpperCase()];
    const re = /RequestMethod\.([A-Z]+)/g;
    const ms = [...params.matchAll(re)];
    return ms.length ? ms.map(x => x[1]) : ["REQUEST"];
}

// ---------------------------
//  CONSTRUCCIÓN DE LA URL
// ---------------------------
function mapJavaTypeToFriendly(type) {
    if (!type) return "string";
    const t = type.toLowerCase();
    if (["int", "integer", "long", "short"].includes(t)) return "int";
    if (t.includes("uuid")) return "uuid";
    if (t.includes("boolean")) return "bool";
    if (t.includes("double") || t.includes("float") || t.includes("bigdecimal")) return "number";
    return "string";
}
function buildBeautifiedPath(path, pathVars) {
    if (!path) path = "";
    const clean = path.startsWith("/") ? path : "/" + path;
    return clean.replace(/\{(\w+)\}/g, (_m, name) => {
        const pv = pathVars.find(p => p.name === name);
        return `{${name}:${mapJavaTypeToFriendly(pv?.type)}}`;
    });
}
function buildFullUrl(baseUrl, classBase, methodPath) {
    let base = baseUrl.replace(/\/+$/, "");
    const basePath = (classBase || "").replace(/^\/+/, "");
    const mPath = (methodPath || "").replace(/^\/+/, "");
    let url = base;
    if (basePath) url += "/" + basePath;
    url += "/" + mPath;
    // Normaliza // pero respeta http(s)://
    url = url.replace(/([^:])\/{2,}/g, "$1/");
    return url;
}
function buildQueryParams(params) {
    if (!params || !params.length) return "";
    // dedup por nombre + orden alfabético
    const map = new Map();
    for (const p of params) {
        const key = (p.name || "").trim();
        if (!key) continue;
        map.set(key, p.type);
    }
    return Array.from(map.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, type]) => `${name}:${mapJavaTypeToFriendly(type)}`)
        .join("&");
}

// ---------------------------
//  BORRADO SEGURO (solo los de la extensión)
// ---------------------------
function collectOldEndpointCommentsAbove(document, lines, startLine) {
    const ranges = [];
    let line = startLine - 1;
    while (line >= 0) {
        const txt = lines[line];
        if (!txt) break;
        const trimmed = txt.trim();
        // Solo borra los comentarios que generamos nosotros
        if (
            trimmed.startsWith("// GET ") ||
            trimmed.startsWith("// POST ") ||
            trimmed.startsWith("// PUT ") ||
            trimmed.startsWith("// DELETE ") ||
            trimmed.startsWith("// REQUEST ")
        ) {
            ranges.push(document.lineAt(line).rangeIncludingLineBreak);
            line--;
            continue;
        }
        break;
    }
    return ranges;
}

function getIndentOfLine(lineText) {
    const m = lineText.match(/^(\s*)/);
    return m ? m[1] : "";
}

function deactivate() { }

module.exports = { activate, deactivate };
