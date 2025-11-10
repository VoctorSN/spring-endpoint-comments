const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

function activate(context) {

    let disposable = vscode.commands.registerCommand(
        "extension.addEndpointComment",
        async function () {

            const files = await vscode.workspace.findFiles("**/*.java");

            for (const file of files) {
                const doc = await vscode.workspace.openTextDocument(file);
                const fullText = doc.getText();

                if (!fullText.includes("@Controller") && !fullText.includes("@RestController")) {
                    continue;
                }

                await processControllerDocument(doc);
            }

            vscode.window.showInformationMessage("Comentarios actualizados en todos los controladores del workspace.");
        }
    );

    context.subscriptions.push(disposable);

    //
    // SEMANTIC TOKENS
    //
    const legend = new vscode.SemanticTokensLegend(["placeholder"]);

    vscode.languages.registerDocumentRangeSemanticTokensProvider(
        { language: "java", scheme: "file" },
        {
            provideDocumentRangeSemanticTokens(doc, range) {
                const text = doc.getText(range);
                const builder = new vscode.SemanticTokensBuilder(legend);

                const regex = /\{(\w+:\w+)\}/g;
                let match;

                const offset = doc.offsetAt(range.start);

                while ((match = regex.exec(text)) !== null) {
                    const start = doc.positionAt(offset + match.index + 1);
                    const length = match[1].length;
                    builder.push(start, length, "placeholder");
                }

                return builder.build();
            }
        },
        legend
    );
}

//
// ============================
//   PROCESAR CONTROLADOR
// ============================
//


async function detectSpringPort() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return null;

    const root = workspaceFolders[0].uri.fsPath;

    const propsPath = path.join(root, "src", "main", "resources", "application.properties");

    if (fs.existsSync(propsPath)) {
        const content = fs.readFileSync(propsPath, "utf8");
        const match = content.match(/server\.port\s*=\s*(\d+)/);
        if (match) return match[1];
    }

    return null;
} 

async function getServerPort() {
    let port = await detectSpringPort();
    if (port) return port;

    port = await detectSpringPortYaml();
    if (port) return port;

    return "8080"; // default
}


async function detectSpringPortYaml() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return null;

    const root = workspaceFolders[0].uri.fsPath;

    const yamlFiles = [
        path.join(root, "src", "main", "resources", "application.yml"),
        path.join(root, "src", "main", "resources", "application.yaml")
    ];

    for (const file of yamlFiles) {
        if (fs.existsSync(file)) {
            const content = fs.readFileSync(file, "utf8");
            const match = content.match(/server:\s*\n\s*port:\s*(\d+)/);
            if (match) return match[1];
        }
    }

    return null;
}



async function processControllerDocument(document) {

    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const fullText = document.getText();

    const config = vscode.workspace.getConfiguration("springEndpointComments");
    let baseUrl = config.get("baseUrl") || "https://localhost:8080";

    // Detectar puerto dinámicamente
    const detectedPort = await getServerPort();
    baseUrl = baseUrl.replace(/\:\d+/, ":" + detectedPort);

    const edits = [];

    //
    // DETECTAR RequestMapping DEL CONTROLADOR
    //
    let classBasePath = "";
    const classAnnotationRegex = /@RequestMapping\s*\(\s*([^)]*)\)/;
    const classMatch = fullText.match(classAnnotationRegex);

    if (classMatch) {
        const params = classMatch[1].trim();

        const simpleMatch = params.match(/^"(.*?)"$/);
        if (simpleMatch) classBasePath = simpleMatch[1];

        const namedMatch = params.match(/(path|value)\s*=\s*(\{[^}]*\}|".*?")/);
        if (namedMatch) {
            const paths = extractPaths(namedMatch[2]);
            classBasePath = paths[0];
        }

        const arrayMatch = params.match(/^\{(.*?)\}$/);
        if (arrayMatch) {
            const paths = extractPaths("{" + arrayMatch[1] + "}");
            classBasePath = paths[0];
        }
    }

    //
    // DETECTAR MÉTODOS
    //
    const methodRegex =
        /@(GetMapping|PostMapping|PutMapping|DeleteMapping|RequestMapping)\(([^)]*)\)/g;

    let match;
    while ((match = methodRegex.exec(fullText)) !== null) {

        const annotation = match[1];
        const params = match[2];

        if (annotation === "RequestMapping") {
            const classIndex = fullText.indexOf("class ");
            if (match.index < classIndex) continue;
        }

        const annotationPos = document.positionAt(match.index);
        const line = annotationPos.line;

        const methodSource = extractMethodSource(document, annotationPos);

        //
        // ✅ (NUEVO) Extraer @RequestParam
        //
        const requestParams = extractRequestParams(methodSource);

        //
        // @PathVariable
        //
        const pathVars = extractMethodParamTypes(methodSource);

        const methodPaths = extractPathsFromParams(params);
        const httpMethods = extractHttpMethods(annotation, params);

        removePreviousComments(line, document, edits);

        //
        // CREAR COMENTARIOS
        //
        for (const http of httpMethods) {
            for (const mp of methodPaths) {

                const cleanBase = classBasePath
                    ? (classBasePath.startsWith("/") ? classBasePath : "/" + classBasePath)
                    : "";

                const cleanMethod = mp.startsWith("/") ? mp : "/" + mp;

                const prettyPath = buildBeautifiedPath(cleanMethod, pathVars);

                let base = baseUrl.replace(/\/+$/, "");
                let basePath = cleanBase.replace(/^\/+/, "");
                let methodPath = prettyPath.replace(/^\/+/, "");

                let finalUrl = base;

                if (basePath.length > 0) finalUrl += "/" + basePath;

                finalUrl += "/" + methodPath;

                //
                // ✅ (NUEVO) Añadir query params
                //
                const query = buildQueryParams(requestParams);
                if (query.length > 0) finalUrl += "?" + query;

                finalUrl = finalUrl.replace(/\/{2,}/g, "/");
                finalUrl = finalUrl.replace("https:/", "https://");
                finalUrl = finalUrl.replace("http:/", "http://");

                const comment = `// ${http} ${finalUrl}\n`;
                edits.push({ position: annotationPos, text: comment });
            }
        }
    }

    if (edits.length > 0) {
        await editor.edit((builder) => {
            for (let i = edits.length - 1; i >= 0; i--) {
                const e = edits[i];
                if (e.deleteRange) builder.delete(e.deleteRange);
                if (e.text) builder.insert(e.position, e.text);
            }
        });

        await document.save();
    }
}

//
// =====================
//  HELPERS
// =====================
//

function removePreviousComments(line, document, edits) {
    let curr = line - 1;
    while (curr >= 0) {
        const txt = document.lineAt(curr).text.trim();
        if (!txt.startsWith("//")) break;
        const fullLineRange = document.lineAt(curr).rangeIncludingLineBreak;
        edits.push({ deleteRange: fullLineRange });
        curr--;
    }
}

function extractPaths(raw) {
    const paths = [];
    if (raw.startsWith("{")) {
        const inner = raw.replace("{", "").replace("}", "").split(",")
            .map((s) => s.trim().replace(/"/g, ""));
        paths.push(...inner);
    } else {
        paths.push(raw.replace(/"/g, ""));
    }
    return paths;
}

function extractPathsFromParams(params) {
    const pathRegex = /(path|value)\s*=\s*(\{[^}]*\}|".*?")/;
    const m = params.match(pathRegex);
    if (m) return extractPaths(m[2]);
    const simple = params.match(/"(.*?)"/);
    return simple ? [simple[1]] : [""];
}

function extractHttpMethods(annotation, params) {
    if (annotation !== "RequestMapping") {
        return [annotation.replace("Mapping", "").toUpperCase()];
    }
    const regex = /RequestMethod\.([A-Z]+)/g;
    const matches = [...params.matchAll(regex)];
    if (matches.length > 0) return matches.map((m) => m[1]);
    return ["REQUEST"];
}

function extractMethodSource(document, pos) {
    let text = "";
    let foundSignatureStart = false;

    for (let i = pos.line; i < document.lineCount; i++) {
        const line = document.lineAt(i).text;
        text += line + "\n";

        // Detecta el inicio real de la firma del método
        if (!foundSignatureStart && line.match(/\b(public|private|protected)\b/)) {
            foundSignatureStart = true;
        }

        // una vez dentro de la firma del método, termina al encontrar '{'
        if (foundSignatureStart && line.includes("{")) {
            break;
        }
    }

    return text;
}





// ===============================
// ✅ (NUEVO) EXTRAER REQUESTPARAM
// ===============================
function extractRequestParams(methodText) {
    const regex = /@RequestParam(?:\(([^)]*)\))?\s+([\w<>]+)\s+(\w+)/g;
    // grupos:
    // 1 → contenido dentro de ()
    // 2 → tipo Java (String, Integer...)
    // 3 → nombre real del parámetro

    const out = [];
    let m;

    while ((m = regex.exec(methodText)) !== null) {

        let annotationContent = m[1];   // lo que está dentro de @RequestParam(...)
        let type = m[2];                // tipo real Java
        let paramName = m[3];           // nombre del parámetro en el método

        let nameFromAnnotation = null;

        // Caso @RequestParam("dni")
        if (annotationContent) {
            let simple = annotationContent.match(/["'](\w+)["']/);
            if (simple) nameFromAnnotation = simple[1];

            // Caso @RequestParam(name="dni")
            let named = annotationContent.match(/name\s*=\s*["'](\w+)["']/);
            if (named) nameFromAnnotation = named[1];
        }

        out.push({
            name: nameFromAnnotation || paramName,
            type
        });
    }

    return out;
}



// ===============================
// ✅ (NUEVO) QUERY PARAMS BUILDER
// ===============================
function buildQueryParams(params) {
    if (params.length === 0) return "";

    return params
        .map((p) => {
            const friendly = mapJavaTypeToFriendly(p.type);
            return `${p.name}:${friendly}`;
        })
        .join("&");
}


function extractMethodParamTypes(methodText) {
    const regex =
        /@PathVariable\s*(?:\(\s*["']?(\w+)["']?\s*\))?\s+([\w<>]+)/g;

    const out = [];
    let m;
    while ((m = regex.exec(methodText)) !== null) {
        const name = m[1];
        const type = m[2];
        out.push({ name, type });
    }
    return out;
}

function mapJavaTypeToFriendly(type) {
    if (!type) return "string";
    const t = type.toLowerCase();
    if (["int", "integer", "long", "short"].includes(t)) return "int";
    if (t.includes("uuid")) return "uuid";
    if (t.includes("boolean")) return "bool";
    if (t.includes("double") || t.includes("float") || t.includes("bigdecimal"))
        return "number";
    return "string";
}

function buildBeautifiedPath(path, paramTypes) {
    return path.replace(/\{(\w+)\}/g, (match, name) => {
        const param = paramTypes.find((p) => p.name === name);
        const friendly = mapJavaTypeToFriendly(param?.type);
        return `{${name}:${friendly}}`;
    });
}

function deactivate() { }

module.exports = { activate, deactivate };
