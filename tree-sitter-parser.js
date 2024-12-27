const Parser = require('tree-sitter');
const JavaScript = require('tree-sitter-javascript');
const TypeScript = require('tree-sitter-typescript/typescript');
const TSX = require('tree-sitter-typescript/tsx');
const fs = require('fs');

class TreeSitterParser {
    constructor() {
        this.parser = new Parser();
        // 根据文件扩展名选择解析器
        this.parsers = {
            js: JavaScript,
            jsx: JavaScript,
            ts: TypeScript,
            tsx: TSX
        };
        this.functions = new Map();
        this.relations = new Map();
        this.imports = new Map();
    }

    // 处理Mermaid语法的特殊字符
    escapeMermaid(str) {
        return str.replace(/[<>{}|]/g, '\\$&');
    }

    // 添加函数声明
    addFunction(name, location, type = 'function') {
        if (!this.functions.has(name)) {
            this.functions.set(name, {
                type,
                location,
                calls: new Set()
            });
        }
    }

    // 添加函数调用关系
    addRelation(caller, callee, location) {
        const key = `${caller}:${callee}`;
        if (!this.relations.has(key)) {
            this.relations.set(key, location);
            if (this.functions.has(caller)) {
                this.functions.get(caller).calls.add(callee);
            }
        }
    }

    // 获取节点的完整名称
    getFullName(node, parentClass = null) {
        let name = '';
        switch (node.type) {
            case 'function_declaration':
            case 'generator_function_declaration':
            case 'method_definition':
                name = node.children.find(child => child.type === 'identifier')?.text;
                break;
            case 'class_declaration':
                name = node.children.find(child => child.type === 'identifier')?.text;
                break;
            case 'arrow_function':
                const parent = node.parent;
                if (parent.type === 'variable_declarator') {
                    name = parent.children.find(child => child.type === 'identifier')?.text;
                }
                break;
        }
        return parentClass ? `${parentClass}.${name}` : name;
    }

    // 处理函数调用节点
    processCallExpression(node, currentScope) {
        let calleeName = '';
        const calleeNode = node.children.find(child => child.type === 'identifier');

        if (calleeNode) {
            calleeName = calleeNode.text;
            if (this.functions.has(calleeName)) {
                this.addRelation(
                    currentScope,
                    calleeName,
                    `${calleeNode.startPosition.row + 1}:${calleeNode.startPosition.column}`
                );
            }
        }
    }

    // 处理导入语句
    processImports(node) {
        if (node.type === 'import_statement' || node.type === 'import_declaration') {
            const defaultImport = node.children.find(child => 
                child.type === 'identifier' || 
                (child.type === 'import_clause' && child.children.some(c => c.type === 'identifier'))
            );

            const namedImports = node.children.find(child => 
                child.type === 'named_imports' || 
                child.type === 'import_clause'
            );

            if (defaultImport) {
                const name = defaultImport.type === 'identifier' ? 
                    defaultImport.text : 
                    defaultImport.children.find(c => c.type === 'identifier').text;
                this.imports.set(name, `import:${name}`);
            }

            if (namedImports) {
                namedImports.children
                    .filter(child => child.type === 'import_specifier')
                    .forEach(specifier => {
                        const name = specifier.children.find(c => c.type === 'identifier').text;
                        this.imports.set(name, `import:${name}`);
                    });
            }
        }
    }

    // 遍历语法树
    traverseTree(node, parentClass = null, currentScope = 'global') {
        if (!node) return;

        // 处理导入
        this.processImports(node);

        switch (node.type) {
            case 'class_declaration':
                const className = this.getFullName(node);
                this.addFunction(className, node.startPosition.row + 1, 'class');
                parentClass = className;
                break;

            case 'function_declaration':
            case 'generator_function_declaration':
            case 'method_definition':
                const funcName = this.getFullName(node, parentClass);
                if (funcName) {
                    this.addFunction(funcName, node.startPosition.row + 1);
                    currentScope = funcName;
                }
                break;

            case 'arrow_function':
                const arrowFuncName = this.getFullName(node, parentClass);
                if (arrowFuncName) {
                    this.addFunction(arrowFuncName, node.startPosition.row + 1, 'arrow');
                    currentScope = arrowFuncName;
                }
                break;

            case 'call_expression':
                this.processCallExpression(node, currentScope);
                break;
        }

        // 递归处理子节点
        for (const child of node.children) {
            this.traverseTree(child, parentClass, currentScope);
        }
    }

    // 解析文件
    parse(filePath) {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const ext = filePath.split('.').pop().toLowerCase();
            const parser = this.parsers[ext];

            if (!parser) {
                console.error(`No parser available for extension: ${ext}`);
                return '[]';
            }

            this.parser.setLanguage(parser);
            const tree = this.parser.parse(content);

            // 第一遍遍历收集所有函数声明
            this.traverseTree(tree.rootNode);

            // 结果格式化
            const results = Array.from(this.relations.entries()).map(([key, location]) => {
                const [caller, callee] = key.split(':');
                return [
                    this.escapeMermaid(`${location}: ${caller}`),
                    this.escapeMermaid(callee)
                ];
            });

            return JSON.stringify(results);
        } catch (error) {
            console.error(`Error processing ${filePath}: ${error.message}`);
            return '[]';
        }
    }
}

// 命令行入口
if (require.main === module) {
    const filePath = process.argv[2];
    if (filePath) {
        const parser = new TreeSitterParser();
        console.log(parser.parse(filePath));
    }
}

module.exports = TreeSitterParser;