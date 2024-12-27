const Parser = require('tree-sitter');
const JavaScript = require('tree-sitter-javascript');
const TypeScript = require('tree-sitter-typescript/typescript');
const TSX = require('tree-sitter-typescript/tsx');
const fs = require('fs');

class TreeSitterParser {
    constructor() {
        this.parser = new Parser();
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

    escapeMermaid(str) {
        return str.replace(/[<>{}|]/g, '\\$&');
    }

    addFunction(name, location, type = 'function') {
        // console.log('Adding function:', { name, location, type });
        if (!this.functions.has(name)) {
            this.functions.set(name, {
                type,
                location,
                calls: new Set()
            });
        }
    }

    addRelation(caller, callee, location) {
        // console.log('Adding relation:', { caller, callee, location });
        const key = `${caller}:${callee}`;
        if (!this.relations.has(key)) {
            this.relations.set(key, location);
            if (this.functions.has(caller)) {
                this.functions.get(caller).calls.add(callee);
            }
        }
    }

    processImports(node) {
        if (node.type === 'import_statement') {
            let source = '';
            const imports = new Map();  // 使用Map暂存导入信息

            // 遍历子节点以获取完整信息
            node.children.forEach(child => {
                if (child.type === 'string') {
                    source = child.text.slice(1, -1); // 移除引号
                } else if (child.type === 'import_clause') {
                    child.children.forEach(importChild => {
                        if (importChild.type === 'identifier') {
                            imports.set(importChild.text, importChild.text);
                        } else if (importChild.type === 'named_imports') {
                            importChild.children.forEach(namedChild => {
                                if (namedChild.type === 'import_specifier') {
                                    const original = namedChild.children[0]?.text;
                                    let alias = original;
                                    
                                    // 检查是否有as语法
                                    const asIdentifier = namedChild.children.find((c, i) => 
                                        i > 0 && c.type === 'identifier'
                                    );
                                    if (asIdentifier) {
                                        alias = asIdentifier.text;
                                    }
                                    
                                    if (original) {
                                        // console.log(`Found import: ${original}${alias !== original ? ` as ${alias}` : ''} from ${source}`);
                                        imports.set(alias, original);
                                    }
                                }
                            });
                        }
                    });
                }
            });

            // 记录所有导入
            imports.forEach((original, alias) => {
                // console.log(`Recording import: ${alias} -> ${original}`);
                this.imports.set(alias, `import:${original}`);
            });
        }
    }

    getComponentName(node) {
        const identifier = node.children.find(child => child.type === 'identifier');
        return identifier ? identifier.text : null;
    }

    processJSXElement(node, currentScope) {
        const processElement = (element) => {
            const componentName = this.getComponentName(element);
            if (componentName && /^[A-Z]/.test(componentName)) {
                // console.log('Found JSX component:', componentName, 'in scope:', currentScope);
                if (this.imports.has(componentName)) {
                    const location = `${element.startPosition.row + 1}:${element.startPosition.column}`;
                    this.addRelation(currentScope, componentName, location);
                }

                // 处理属性中的组件引用
                const attributes = element.children.filter(c => c.type === 'jsx_attribute');
                attributes.forEach(attr => {
                    const propName = attr.children[0]?.text;
                    const expression = attr.children.find(c => c.type === 'jsx_expression');
                    
                    if (expression) {
                        // 处理element属性中的组件
                        if (propName === 'element') {
                            const component = expression.children.find(c => 
                                c.type === 'identifier' ||
                                c.type === 'jsx_element' ||
                                c.type === 'jsx_self_closing_element'
                            );
                            
                            if (component) {
                                if (component.type === 'identifier') {
                                    const name = component.text;
                                    if (this.imports.has(name)) {
                                        const location = `${component.startPosition.row + 1}:${component.startPosition.column}`;
                                        this.addRelation(currentScope, name, location);
                                    }
                                } else {
                                    processElement(component);
                                }
                            }
                        }
                        
                        // 处理其他属性中的组件引用
                        expression.children.forEach(child => {
                            if (child.type === 'identifier' && this.imports.has(child.text)) {
                                const location = `${child.startPosition.row + 1}:${child.startPosition.column}`;
                                this.addRelation(currentScope, child.text, location);
                            }
                        });
                    }
                });
            }
        };

        // 处理根元素
        if (node.type === 'jsx_element') {
            const openingElement = node.children.find(child => 
                child.type === 'jsx_opening_element'
            );
            if (openingElement) {
                processElement(openingElement);
                
                // 处理子元素
                node.children.forEach(child => {
                    if (child.type === 'jsx_element' || child.type === 'jsx_self_closing_element') {
                        this.processJSXElement(child, currentScope);
                    }
                });
            }
        } else if (node.type === 'jsx_self_closing_element') {
            processElement(node);
        }
    }

    traverseTree(node, parentClass = null, currentScope = 'global') {
        if (!node) return;

        const type = node.type;

        switch (type) {
            case 'import_statement':
                this.processImports(node);
                break;

            case 'function_declaration':
                const funcName = this.getComponentName(node);
                if (funcName) {
                    this.addFunction(funcName, node.startPosition.row + 1);
                    currentScope = funcName;
                }
                break;

            case 'jsx_element':
            case 'jsx_self_closing_element':
                this.processJSXElement(node, currentScope);
                break;

            case 'variable_declaration':
                const declarator = node.children.find(child => child.type === 'variable_declarator');
                if (declarator) {
                    const id = declarator.children.find(child => child.type === 'identifier');
                    if (id) {
                        this.addFunction(id.text, node.startPosition.row + 1, 'variable');
                    }
                }
                break;
        }

        node.children.forEach(child => {
            this.traverseTree(child, parentClass, currentScope);
        });
    }

    parse(filePath) {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const ext = filePath.split('.').pop().toLowerCase();
            
            // console.log(`\nParsing ${filePath} (${ext})`);
            
            const parser = this.parsers[ext];
            if (!parser) {
                console.error(`No parser available for extension: ${ext}`);
                return '[]';
            }
            
            this.parser.setLanguage(parser);
            const tree = this.parser.parse(content);
            
            this.traverseTree(tree.rootNode);

            // console.log('\nCollected data:');
            // console.log('Imports:', Array.from(this.imports.entries()));
            // console.log('Functions:', Array.from(this.functions.entries()));
            // console.log('Relations:', Array.from(this.relations.entries()));

            const results = Array.from(this.relations.entries()).map(([key, location]) => {
                const [caller, callee] = key.split(':');
                return [
                    this.escapeMermaid(`${location}: ${caller}`),
                    this.escapeMermaid(callee)
                ];
            });

            return JSON.stringify(results);

        } catch (error) {
            console.error(`Error processing ${filePath}:`, error);
            return '[]';
        }
    }
}

if (require.main === module) {
    const filePath = process.argv[2];
    if (filePath) {
        const parser = new TreeSitterParser();
        console.log(parser.parse(filePath));
    }
}

module.exports = TreeSitterParser;
