const vscode = require("vscode");

function activate(context) {
    let disposable = vscode.commands.registerCommand(
        "extension.addEndpointComment",
        function () {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;

            const document = editor.document;
            const text = document.getText();

            // Regex que detecta los métodos con anotación Spring
            const mappingRegex = /@(GetMapping|PostMapping|PutMapping|DeleteMapping|RequestMapping)\(([^)]*)\)/g;

            const edits = [];
            let match;

            while ((match = mappingRegex.exec(text)) !== null) {
                const fullMatch = match[0];
                const httpMethod = match[1];
                const params = match[2];

                // Extraer ruta
                const pathMatch = params.match(/"(.*?)"/);
                const path = pathMatch ? pathMatch[1] : "";

                // Calcular posición del comentario
                const startPos = document.positionAt(match.index);

                const comment = `// Endpoint: ${httpMethod.replace(
                    "Mapping",
                    ""
                ).toUpperCase()} ${path}\n`;

                edits.push({ position: startPos, text: comment });
            }

            if (edits.length === 0) {
                vscode.window.showInformationMessage("No se encontraron endpoints Spring.");
                return;
            }

            editor.edit((builder) => {
                // Insertar comentarios en orden inverso para no romper los offsets
                for (let i = edits.length - 1; i >= 0; i--) {
                    builder.insert(edits[i].position, edits[i].text);
                }
            });
        }
    );

    context.subscriptions.push(disposable);
}

function deactivate() { }

module.exports = {
    activate,
    deactivate,
};
