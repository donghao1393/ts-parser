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

    // 获取成员表达式的完整名称
    getMemberExpressionName(node) {
        const parts = [];
        let current = node;
        
        while (current) {
            if (current.type === 'identifier') {
                parts.unshift(current.text);
                break;
            } else if (current.type === 'member_expression') {
                const property = current.children.find(c => c.type === 'property_identifier');
                if (property) {
                    parts.unshift(property.text);
                }
                current = current.children.find(c => c.type === 'identifier' || c.type === 'member_expression');
            } else {
                break;
            }
        }
        
        return parts.join('.');
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

    // 处理变量声明
    processVariableDeclaration(node, currentScope) {
        const declarator = node.children.find(child => child.type === 'variable_declarator');
        if (declarator) {
            // 获取变量名
            const identifier = declarator.children.find(child => child.type === 'identifier');
            const value = declarator.children.find(child => 
                child.type === 'call_expression' || 
                child.type === 'member_expression'
            );

            if (identifier && value) {
                const varName = identifier.text;
                
                // 记录函数定义
                if (value.type === 'call_expression') {
                    // 处理函数调用
                    const callee = value.children[0];
                    if (callee.type === 'identifier') {
                        const calleeName = callee.text;
                        this.addRelation(
                            currentScope,
                            calleeName,
                            `${node.startPosition.row + 1}:${node.startPosition.column}`
                        );
                    }
                }

                // 将变量添加到函数映射中，以便后续追踪使用
                this.functions.set(varName, {
                    type: 'variable',
                    location: node.startPosition.row + 1,
                    calls: new Set()
                });
            }
        }
    }

    // 处理函数调用节点
    processCallExpression(node, currentScope) {
        let calleeName = '';
        
        // 普通函数调用
        if (node.childCount >= 1) {
            const calleeNode = node.children[0];
            if (calleeNode.type === 'identifier') {
                calleeName = calleeNode.text;
            } else if (calleeNode.type === 'member_expression') {
                calleeName = this.getMemberExpressionName(calleeNode);
            }
            
            if (calleeName && (this.functions.has(calleeName) || this.imports.has(calleeName))) {
                this.addRelation(
                    currentScope,
                    calleeName,
                    `${node.startPosition.row + 1}:${node.startPosition.column}`
                );
            }
        }
    }

    // 处理JSX属性中的组件引用
    processJSXAttributes(element, currentScope) {
        element.children
            .filter(child => child.type === 'jsx_attribute')
            .forEach(attr => {
                const name = attr.children.find(c => c.type === 'property_identifier')?.text;
                if (name === 'element') {  // 特别处理Route的element属性
                    const expression = attr.children.find(c => c.type === 'jsx_expression');
                    if (expression) {
                        const componentRef = expression.children.find(c => 
                            c.type === 'jsx_element' || 
                            c.type === 'jsx_self_closing_element'
                        );
                        if (componentRef) {
                            this.processJSXElement(componentRef, currentScope);
                        }
                    }
                }
            });
    }

    // 处理JSX元素
    processJSXElement(node, currentScope) {
        const elements = [];
        
        // 处理开标签或自闭合标签
        const openingElement = node.children.find(child => 
            child.type === 'jsx_opening_element' || 
            child.type === 'jsx_self_closing_element'
        );
        
        if (openingElement) {
            // 识别JSX组件
            const tagIdentifier = openingElement.children.find(child => child.type === 'identifier');
            if (tagIdentifier && /^[A-Z]/.test(tagIdentifier.text)) {
                const componentName = tagIdentifier.text;
                if (this.imports.has(componentName) || this.functions.has(componentName)) {
                    this.addRelation(
                        currentScope,
                        componentName,
                        `${openingElement.startPosition.row + 1}:${openingElement.startPosition.column}`
                    );
                }
                
                // 处理属性中的组件引用
                this.processJSXAttributes(openingElement, currentScope);
            }
        }

        // 递归处理子JSX元素
        node.children
            .filter(child => child.type === 'jsx_element' || child.type === 'jsx_self_closing_element')
            .forEach(child => this.processJSXElement(child, currentScope));
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

            case 'jsx_element':
            case 'jsx_self_closing_element':
                this.processJSXElement(node, currentScope);
                break;

            case 'lexical_declaration':
            case 'variable_declaration':
                this.processVariableDeclaration(node, currentScope);
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
            
            // 只保留重要日志
            console.log(`Parsing ${filePath} (${ext})`);
            
            const parser = this.parsers[ext];
            if (!parser) {
                console.error(`No parser available for extension: ${ext}`);
                return '[]';
            }
            
            this.parser.setLanguage(parser);
            const tree = this.parser.parse(content);

            // 第一遍遍历收集所有函数声明
            this.traverseTree(tree.rootNode);

            // 收集的信息
            const summary = {
                functions: Array.from(this.functions.entries()).length,
                relations: this.relations.size,
                imports: this.imports.size
            };
            console.log('Summary:', summary);

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