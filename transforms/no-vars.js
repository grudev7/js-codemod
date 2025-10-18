/**
 * Codemod: Convert `var` to `let` or `const`
 * Logic:
 * - Keeps `var` if it’s used before declaration, used in closures, or redeclared.
 * - Converts to `let` if mutated (reassigned or updated).
 * - Converts to `const` otherwise.
 */

module.exports = function (file, api) {
  const j = api.jscodeshift;
  const root = j(file.source);

  const TOP_LEVEL_TYPES = new Set([
    'Function',
    'FunctionDeclaration',
    'FunctionExpression',
    'ArrowFunctionExpression',
    'Program',
  ]);
  const FOR_STATEMENTS = new Set(['ForStatement', 'ForOfStatement', 'ForInStatement']);

  const getScopeNode = (path) => {
    let scope = path;
    let isInFor = FOR_STATEMENTS.has(path.value.type);
    while (!TOP_LEVEL_TYPES.has(scope.node.type)) {
      scope = scope.parentPath;
      if (FOR_STATEMENTS.has(scope.value.type)) isInFor = true;
    }
    return { scope, isInFor };
  };

  const extractNames = (id) => {
    if (!id) return [];
    switch (id.type) {
      case 'Identifier':
        return [id.name];
      case 'RestElement':
        return [id.argument.name];
      case 'ObjectPattern':
        return id.properties.flatMap((p) =>
          p.type === 'SpreadProperty'
            ? [p.argument.name]
            : extractNames(p.value)
        );
      case 'ArrayPattern':
        return id.elements.flatMap(extractNames);
      default:
        return [];
    }
  };

  const getDeclaratorNames = (decl) => extractNames(decl.id);
  const isIdInDeclarator = (decl, name) => getDeclaratorNames(decl).includes(name);

  const getLocalScopeNames = (scope, parent) => {
    const names = new Set();
    while (scope !== parent) {
      if (Array.isArray(scope.value.body)) {
        for (const node of scope.value.body) {
          if (node.type === 'VariableDeclaration') {
            for (const decl of node.declarations) {
              getDeclaratorNames(decl).forEach((n) => names.add(n));
            }
          }
        }
      }
      if (Array.isArray(scope.value.params)) {
        for (const param of scope.value.params) {
          extractNames(param).forEach((n) => names.add(n));
        }
      }
      scope = scope.parentPath;
    }
    return [...names];
  };

  const hasLocalDeclaration = (node, parentScope, name) =>
    getLocalScopeNames(node, parentScope).includes(name);

  const findFunctionDeclaration = (node, container) => {
    while (node.value.type !== 'FunctionDeclaration' && node !== container)
      node = node.parentPath;
    return node !== container ? node : null;
  };

  const isTrulyVar = (node, declarator) => {
    const block = node.parentPath;
    const { scope, isInFor } = getScopeNode(block);

    // var inside for-loop closure → unsafe
    const usedInClosure =
      isInFor &&
      j(block)
        .find(j.Function)
        .some((fn) =>
          j(fn)
            .find(j.Identifier)
            .some((id) => isIdInDeclarator(declarator, id.value.name))
        );

    // redeclared variable → unsafe
    const redeclared = j(scope)
      .find(j.VariableDeclarator)
      .filter(
        (d) =>
          d.value !== declarator &&
          getScopeNode(d).scope === scope &&
          getDeclaratorNames(d.value).some((n) =>
            isIdInDeclarator(declarator, n)
          )
      )
      .size() > 0;

    if (usedInClosure || redeclared) return true;

    // references before declaration or outside scope
    return (
      j(scope)
        .find(j.Identifier)
        .filter((id) => {
          if (!isIdInDeclarator(declarator, id.value.name)) return false;

          const funcDecl = findFunctionDeclaration(id, scope);
          if (
            funcDecl &&
            j(scope)
              .find(j.Identifier)
              .some(
                (ref) =>
                  ref.value.name === funcDecl.value.id?.name &&
                  ref.value.start < declarator.start
              )
          ) {
            return true;
          }

          const refScope = getScopeNode(id.parent).scope;
          const isOutside =
            j(block)
              .find(j.Identifier)
              .filter((inner) => inner.node.start === id.node.start)
              .size() === 0;
          const usedBefore = id.value.start < declarator.start;

          return (
            refScope === scope && !hasLocalDeclaration(id, scope, id.value.name)
              ? isOutside || usedBefore
              : false
          );
        })
        .size() > 0
    );
  };

  const isMutated = (node, decl) => {
    const scope = node.parent;
    return (
      j(scope)
        .find(j.AssignmentExpression)
        .some((n) =>
          extractNames(n.value.left).some((name) =>
            isIdInDeclarator(decl, name)
          )
        ) ||
      j(scope)
        .find(j.UpdateExpression)
        .some((n) => isIdInDeclarator(decl, n.value.argument.name))
    );
  };

  const updated = root
    .find(j.VariableDeclaration)
    .filter((d) => d.value.kind === 'var')
    .forEach((decl) => {
      const allSafe = decl.value.declarations.every(
        (dec) => !isTrulyVar(decl, dec)
      );
      if (!allSafe) return;

      const needsLet = decl.value.declarations.some(
        (d) =>
          (!d.init &&
            !['ForOfStatement', 'ForInStatement'].includes(
              decl.parentPath.value.type
            )) ||
          isMutated(decl, d)
      );

      decl.value.kind = needsLet ? 'let' : 'const';
    })
    .size() > 0;

  return updated ? root.toSource() : null;
};
