'use strict'

const cds = require('@sap/cds/lib')
const { computeColumnsToBeSearched } = require('@sap/cds/libx/_runtime/cds-services/services/utils/columns.js')

const infer = require('./infer')

/**
 * For operators of <eqOps>, this is replaced by comparing all leaf elements with null, combined with and.
 * If there are at least two leaf elements and if there are tokens before or after the recognized pattern, we enclose the resulting condition in parens (...)
 */
const eqOps = [['is'], ['='] /* ['=='] */]
/**
 * For operators of <notEqOps>, do the same but use or instead of and.
 * This ensures that not struc == <value> is the same as struc != <value>.
 */
const notEqOps = [['is', 'not'], ['<>'], ['!=']]
/**
 * not supported in comparison w/ struct because of unclear semantics
 */
const notSupportedOps = [['>'], ['<'], ['>='], ['<=']]

const allOps = eqOps.concat(eqOps).concat(notEqOps).concat(notSupportedOps)

const { pseudos } = require('./infer/pseudos')
/**
 * Transforms a CDL style query into SQL-Like CQN:
 *  - transform association paths in `from` to `WHERE exists` subqueries
 *  - transforms columns into their flat representation.
 *      1. Flatten managed associations to their foreign
 *      2. Flatten structures to their leafs
 *      3. Replace join-relevant ref paths (i.e. non-fk accesses in association paths) with the correct join alias
 *  - transforms `expand` columns into special, normalized subqueries
 *  - transform `where` clause.
 *      That is the flattening of all `ref`s and the expansion of `where exists` predicates
 *  - rewrites `from` clause:
 *      Each join relevant association path traversal is translated to a join condition.
 *
 * `cqn4sql` is applied recursively to all queries found in `from`, `columns` and `where`
 *  of a query.
 *
 * @param {object} query
 * @param {object} model
 * @returns {object} transformedQuery the transformed query
 */
function cqn4sql(query, model = cds.context?.model || cds.model) {
  const inferred = infer(query, model)
  if (query.SELECT?.from.args && !query.joinTree) return inferred

  const transformedQuery = cds.ql.clone(inferred)
  const kind = inferred.cmd || Object.keys(inferred)[0]
  if (inferred.INSERT || inferred.UPSERT) {
    const { as } = transformedQuery[kind].into
    transformedQuery[kind].into = { ref: [inferred.target.name] }
    if (as) transformedQuery[kind].into.as = as
    return transformedQuery
  }
  const _ = inferred[kind]
  if (_ || (!inferred.STREAM?.from && inferred.STREAM?.into)) {
    const { entity, where } = _
    const from = _.from || inferred.STREAM?.into

    const transformedProp = { __proto__: _ } // IMPORTANT: don't loose anything you might not know of
    // first transform the existing where, prepend table aliases and so on....
    if (where) transformedProp.where = getTransformedTokenStream(where)
    // now transform the from clause: association path steps turn
    // into `WHERE EXISTS` subqueries. The already transformed `where` clause
    // is then glued together with the resulting subqueries.
    const { transformedWhere, transformedFrom } = getTransformedFrom(from || entity, transformedProp.where)

    if (inferred.SELECT) {
      const { columns, having, groupBy, orderBy, limit } = _

      // trivial replacement -> no transformations needed
      if (limit) transformedQuery.SELECT.limit = limit

      transformedQuery.SELECT.from = transformedFrom
      if (transformedWhere?.length > 0) transformedQuery.SELECT.where = transformedWhere

      if (columns) transformedQuery.SELECT.columns = getTransformedColumns(columns)
      else transformedQuery.SELECT.columns = getColumnsForWildcard()

      // Like the WHERE clause, aliases from the SELECT list are
      // not accessible for `group by`/`having` (in most DB's)
      if (having) transformedQuery.SELECT.having = getTransformedTokenStream(having)

      if (groupBy) {
        const transformedGroupBy = getTransformedOrderByGroupBy(groupBy)
        if (transformedGroupBy.length) transformedQuery.SELECT.groupBy = transformedGroupBy
      }

      // Since all the expressions in the SELECT part of the query have been computed
      // one can reference aliases of the queries columns in the orderBy clause.
      if (orderBy) {
        const transformedOrderBy = getTransformedOrderByGroupBy(orderBy, true)
        if (transformedOrderBy.length) transformedQuery.SELECT.orderBy = transformedOrderBy
      }

      if (inferred.SELECT.search) {
        // search target can be a navigation, in that case use _target to get correct entity
        const entity = transformedFrom.$refLinks[0].definition._target || transformedFrom.$refLinks[0].definition
        const searchIn = computeColumnsToBeSearched(inferred, entity, transformedFrom.as)
        if (searchIn.length > 0) {
          const xpr = inferred.SELECT.search
          const contains = {
            func: 'search',
            args: [
              searchIn.length > 1 ? { list: searchIn } : { ...searchIn[0] },
              xpr.length === 1 && 'val' in xpr[0] ? xpr[0] : { xpr },
            ],
          }
          if (transformedQuery.SELECT.where)
            transformedQuery.SELECT.where = [asXpr(transformedQuery.SELECT.where), 'and', contains]
          else transformedQuery.SELECT.where = [contains]
        }
      }
    } else {
      if (inferred.STREAM?.into) transformedProp.into = transformedFrom
      else if (from) transformedProp.from = transformedFrom
      else transformedProp.entity = transformedFrom
      if (transformedWhere?.length > 0) transformedProp.where = transformedWhere
      transformedQuery[kind] = transformedProp

      if (inferred.UPDATE?.with) {
        Object.entries(inferred.UPDATE.with).forEach(([key, val]) => {
          const transformed = getTransformedTokenStream([val])
          inferred.UPDATE.with[key] = transformed[0]
        })
      }
    }

    if (inferred.joinTree && !inferred.joinTree.isInitial)
      transformedQuery[kind].from = translateAssocsToJoins(transformedQuery[kind].from)
  }
  return transformedQuery

  /**
   * Rewrites the from clause based on the `query.joinTree`.
   *
   * For each join relevant node in the join tree, the respective join is generated.
   * Each join relevant node in the join tree has an unique table alias which is the query source for the respective
   * path traversals. Hence, all join relevant `ref`s must be rewritten to point to the generated join aliases. However,
   * this is done in the @function getFlatColumnsFor().
   *
   * @returns {CQN.from}
   */
  function translateAssocsToJoins() {
    let from
    /**
     * remember already seen aliases, do not create a join for them again
     */
    const alreadySeen = new Map()
    inferred.joinTree._roots.forEach(r => {
      const args = r.queryArtifact.SELECT
        ? [{ SELECT: transformSubquery(r.queryArtifact).SELECT, as: r.alias }]
        : [{ ref: [localized(r.queryArtifact)], as: r.alias }]
      from = { join: 'left', args, on: [] }
      r.children.forEach(c => {
        from = joinForBranch(from, c)
        from = { join: 'left', args: [from], on: [] }
      })
    })
    return from.args.length > 1 ? from : from.args[0]

    function joinForBranch(lhs, node) {
      const nextAssoc = inferred.joinTree.findNextAssoc(node)
      if (!nextAssoc || alreadySeen.has(nextAssoc.$refLink.alias)) return lhs.args.length > 1 ? lhs : lhs.args[0]

      lhs.on.push(
        ...onCondFor(
          nextAssoc.$refLink,
          node.parent.$refLink || /** tree roots do not have $refLink */ {
            alias: node.parent.alias,
            definition: node.parent.queryArtifact,
            target: node.parent.queryArtifact,
          },
          /** flip source and target in on condition */ true,
        ),
      )

      const arg = {
        ref: [localized(model.definitions[nextAssoc.$refLink.definition.target])],
        as: nextAssoc.$refLink.alias,
      }
      lhs.args.push(arg)
      alreadySeen.set(nextAssoc.$refLink.alias, true)
      if (nextAssoc.where) {
        const filter = getTransformedTokenStream(nextAssoc.where, nextAssoc.$refLink)
        lhs.on = [
          ...(hasLogicalOr(lhs.on) ? [asXpr(lhs.on)] : lhs.on),
          'and',
          ...(hasLogicalOr(filter) ? [asXpr(filter)] : filter),
        ]
      }
      if (node.children) {
        node.children.forEach(c => {
          lhs = { join: 'left', args: [lhs], on: [] }
          lhs = joinForBranch(lhs, c)
        })
      }
      return lhs.args.length > 1 ? lhs : lhs.args[0]
    }
  }

  /**
   * Walks over a list of columns (ref's, xpr, subqueries, val), applies flattening on structured types and expands wildcards.
   *
   * @param {object[]} columns
   * @returns {object[]} the transformed representation of the input. Expanded and flattened.
   */
  function getTransformedColumns(columns) {
    const transformedColumns = []
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i]
      const { as } = col

      if (col.expand) {
        const { $refLinks } = col
        const last = $refLinks[$refLinks.length - 1]
        if (last.definition.elements) {
          const expandCols = nestedProjectionOnStructure(col, 'expand')
          transformedColumns.push(...expandCols)
        } else if (!last.skipExpand) {
          // assoc
          const expandedSubqueryColumn = expandColumn(col)
          transformedColumns.push(expandedSubqueryColumn)
        }
      } else if (col.inline) {
        const inlineCols = nestedProjectionOnStructure(col)
        transformedColumns.push(...inlineCols)
      } else if (col.ref) {
        if (pseudos.elements[col.ref[0]]) {
          transformedColumns.push({ ...col })
          continue
        }
        if (col.param) {
          transformedColumns.push({ ...col })
          continue
        }
        const tableAliasName = getQuerySourceName(col)
        const leaf = col.$refLinks[col.$refLinks.length - 1].definition
        if (leaf.virtual === true) continue // already in getFlatColumnForElement
        let baseName
        if (col.ref.length >= 2) {
          // leaf might be intermediate structure
          baseName = col.ref.slice(col.ref[0] === tableAliasName ? 1 : 0, col.ref.length - 1).join('_')
        }
        let columnAlias = col.as || (col.isJoinRelevant ? col.flatName : null)
        const refNavigation = col.ref.slice(col.ref[0] === tableAliasName ? 1 : 0).join('_')
        if (!columnAlias) {
          if (col.flatName && col.flatName !== refNavigation) columnAlias = refNavigation
        }
        if (col.$refLinks.some(link => link.definition._target?.['@cds.persistence.skip'] === true)) continue
        const flatColumns = getFlatColumnsFor(col, baseName, columnAlias, tableAliasName)
        flatColumns.forEach(flatColumn => {
          const { as } = flatColumn
          // might already be present in result through wildcard expansion
          if (!(as && transformedColumns.some(inserted => inserted?.as === as))) transformedColumns.push(flatColumn)
        })
      } else if (col === '*') {
        const wildcardIndex = columns.indexOf('*')
        const ignoreInWildcardExpansion = columns.slice(0, wildcardIndex)
        const { excluding } = inferred.SELECT
        if (excluding) ignoreInWildcardExpansion.push(...excluding)
        const wildcardColumns = getColumnsForWildcard(ignoreInWildcardExpansion, columns.slice(wildcardIndex + 1))
        transformedColumns.push(...wildcardColumns)
      } else {
        let transformedColumn
        if (col.SELECT) {
          if (isLocalized(inferred.target)) col.SELECT.localized = true
          transformedColumn = transformSubquery(col)
        } else if (col.xpr) transformedColumn = { xpr: getTransformedTokenStream(col.xpr) }
        else if (col.func)
          transformedColumn = {
            func: col.func,
            args: col.args && getTransformedTokenStream(col.args),
            as: col.func,
          }
        // {func}.args are optional
        // val
        else transformedColumn = copy(col)
        if (as) transformedColumn.as = as
        const replaceWith = transformedColumns.findIndex(
          t => (t.as || t.ref[t.ref.length - 1]) === transformedColumn.as,
        )
        if (replaceWith === -1) transformedColumns.push(transformedColumn)
        else transformedColumns.splice(replaceWith, 1, transformedColumn)
        // attach `element` helper also to non-ref columns
        Object.defineProperty(transformedColumn, 'element', { value: query.elements[as] })
      }
    }
    // if the removal of virtual columns leads to empty columns array -> error out
    if (transformedColumns.length === 0 && columns.length) {
      // a managed composition exposure is also removed from the columns
      // but in this case, we want to return the empty columns array
      // it is safe to only check the leaf of the ref, as managed compositions can't be defined within structs
      if (columns.some(c => c.$refLinks?.[c.$refLinks.length - 1].definition.type === 'cds.Composition'))
        return transformedColumns
      throw new cds.error('Queries must have at least one non-virtual column')
    }
    return transformedColumns
  }

  /**
   * Calculates the columns for a nested projection on a structure.
   *
   * @param {object} col
   * @param {'inline'|'expand'} prop the property on which to operate. Default is `inline`.
   * @returns a list of flat columns.
   */
  function nestedProjectionOnStructure(col, prop = 'inline') {
    const res = []

    col[prop].forEach((nestedProjection, i) => {
      let rewrittenColumns = []
      if (nestedProjection === '*') {
        res.push(...expandNestedProjectionWildcard(col, i, prop))
      } else {
        const nameParts = col.as ? [col.as] : [col.ref.map(idOnly).join('_')]
        nameParts.push(nestedProjection.as ? nestedProjection.as : nestedProjection.ref.map(idOnly).join('_'))
        const name = nameParts.join('_')
        if (nestedProjection.ref) {
          const augmentedInlineCol = { ...nestedProjection }
          augmentedInlineCol.ref = [...col.ref, ...nestedProjection.ref]
          if (col.as || nestedProjection.as || nestedProjection.isJoinRelevant) {
            augmentedInlineCol.as = nameParts.join('_')
          }
          // propagate join relevance
          Object.defineProperties(augmentedInlineCol, {
            $refLinks: { value: [...col.$refLinks, ...nestedProjection.$refLinks], writable: true },
            isJoinRelevant: {
              value: col.isJoinRelevant || nestedProjection.isJoinRelevant,
              writable: true,
            },
          })
          const flatColumns = getTransformedColumns([augmentedInlineCol])
          flatColumns.forEach(flatColumn => {
            const flatColumnName = flatColumn.as || flatColumn.ref[flatColumn.ref.length - 1]
            if (!res.some(c => (c.as || c.ref.slice(1).map(idOnly).join('_')) === flatColumnName)) {
              const rewrittenColumn = { ...flatColumn }
              if (nestedProjection.as) rewrittenColumn.as = flatColumnName
              rewrittenColumns.push(rewrittenColumn)
            }
          })
        } else {
          // func, xpr, val..
          // we need to check if the column was already added
          // in the wildcard expansion
          if (!res.some(c => (c.as || c.ref.slice(1).map(idOnly).join('_')) === name)) {
            const rewrittenColumn = { ...nestedProjection }
            rewrittenColumn.as = name
            rewrittenColumns.push(rewrittenColumn)
          }
        }
      }
      res.push(...rewrittenColumns)
    })

    return res
  }

  /**
   * Expand the wildcard of the given column into all leaf elements.
   * Respect smart wildcard rules and excluding clause.
   *
   * Every column before the wildcardIndex is excluded from the wildcard expansion.
   * Columns after the wildcardIndex overwrite columns within the wildcard expansion in place.
   *
   * @TODO use this also for `expand` wildcards on structures.
   *
   * @param {csn.Column} col
   * @param {integer} wildcardIndex
   * @returns an array of columns which represents the expanded wildcard
   */
  function expandNestedProjectionWildcard(col, wildcardIndex, prop = 'inline') {
    const res = []
    // everything before the wildcard is inserted before the wildcard
    // and ignored from the wildcard expansion
    const excludeFromExpansion = col[prop].slice(0, wildcardIndex)
    // everything after the wildcard, is a potential replacement
    // in the wildcard expansion
    const replaceInExpansion = []
    // we need to absolutefy the refs
    col[prop].slice(wildcardIndex + 1).forEach(c => {
      const fakeColumn = { ...c }
      if (fakeColumn.ref) {
        fakeColumn.ref = [...col.ref, ...fakeColumn.ref]
        fakeColumn.$refLinks = [...col.$refLinks, ...c.$refLinks]
      }
      replaceInExpansion.push(fakeColumn)
    })
    // respect excluding clause
    if (col.excluding) {
      // fake the ref since excluding only has strings
      col.excluding.forEach(c => {
        const fakeColumn = {
          ref: [...col.ref, c],
        }
        excludeFromExpansion.push(fakeColumn)
      })
    }

    if (col.$refLinks[col.$refLinks.length - 1].definition.kind === 'entity')
      res.push(...getColumnsForWildcard(excludeFromExpansion, replaceInExpansion))
    else
      res.push(
        ...getFlatColumnsFor(col, null, col.as, getQuerySourceName(col), [], excludeFromExpansion, replaceInExpansion),
      )
    return res
  }

  /**
   * Expands a column with an `expand` property to a subquery.
   *
   * For a given query: `SELECT from Authors { books { title } }` do the following:
   *
   * 1. build intermediate query which selects `from <effective query source>:...<column>.ref { ...<column>.expand }`:
   *    - `SELECT from Authors:books as books {title}`
   * 2. add properties `expand: true` and `one: <expand assoc>.is2one`
   * 3. apply `cqn4sql` again on this intermediate query (respect aliases of outer query)
   *    - `cqn4sql(…)` -> `SELECT from Books as books {books.title}
   *                        where exists ( SELECT 1 from Authors as Authors where exists ID = books.author_ID )`
   * 4. Replace the `exists <subquery>` with the where condition of the `<subquery>` and correlate it with the effective query source:
   *    - `SELECT from Books as books { books.title } where Authors.ID = books.author_ID`
   * 5. Replace the `expand` column of the original query with the transformed subquery:
   *    - `SELECT from Authors { (SELECT from Books as books { books.title } where Authors.ID = books.author_ID) as books }`
   *
   * @param {CSN.column} column
   * @returns a subquery, correlated with the enclosing query, having special properties `expand:true` and `one:true|false`
   */
  function expandColumn(column) {
    let outerAlias
    let subqueryFromRef
    if (column.isJoinRelevant) {
      // all n-1 steps of the expand column are already transformed into joins
      // find the last join relevant association. That is the n-1 assoc in the ref path.
      // slice the ref array beginning from the n-1 assoc in the ref and take that as the postfix for the subqueries from ref.
      ;[...column.$refLinks]
        .reverse()
        .slice(1)
        .find((link, i) => {
          if (link.definition.isAssociation) {
            subqueryFromRef = [link.definition.target, ...column.ref.slice(-(i + 1), column.ref.length)]
            // alias of last join relevant association is also the correlation alias for the subquery
            outerAlias = link.alias
            return true
          }
        })
    } else {
      outerAlias = transformedQuery.SELECT.from.as
      subqueryFromRef = [
        ...transformedQuery.SELECT.from.ref,
        ...(column.$refLinks[0].definition.kind === 'entity' ? column.ref.slice(1) : column.ref),
      ]
    }
    // we need to respect the aliases of the outer query
    const uniqueSubqueryAlias = getNextAvailableTableAlias(column.as || column.ref.map(idOnly).join('_'))

    // `SELECT from Authors {  books.genre as genreOfBooks { name } } becomes `SELECT from Books:genre as genreOfBooks`
    const from = { ref: subqueryFromRef, as: uniqueSubqueryAlias }
    const subqueryBase = Object.fromEntries(
      // preserve all props on subquery (`limit`, `order by`, …) but `expand` and `ref`
      Object.entries(column).filter(([key]) => !(key in { ref: true, expand: true })),
    )
    const subquery = {
      SELECT: {
        ...subqueryBase,
        from,
        columns: JSON.parse(JSON.stringify(column.expand)),
        expand: true,
        one: column.$refLinks[column.$refLinks.length - 1].definition.is2one,
      },
    }
    if (isLocalized(inferred.target)) subquery.SELECT.localized = true
    const expanded = cqn4sql(subquery, model)
    const correlated = _correlate({ ...expanded, as: column.as || column.ref.map(idOnly).join('_') }, outerAlias)
    Object.defineProperty(correlated, 'elements', { value: subquery.elements })
    return correlated

    function _correlate(subq, outer) {
      const subqueryFollowingExists = (a, indexOfExists) => a[indexOfExists + 1]
      let {
        SELECT: { where },
      } = subq
      let recent = where
      let i = where.indexOf('exists')
      while (i !== -1) {
        where = subqueryFollowingExists((recent = where), i).SELECT.where
        i = where.indexOf('exists')
      }
      const existsIndex = recent.indexOf('exists')
      recent.splice(
        existsIndex,
        2,
        ...where.map(x => {
          return replaceAliasWithSubqueryAlias(x)
        }),
      )

      function replaceAliasWithSubqueryAlias(x) {
        const existsSubqueryAlias = recent[existsIndex + 1].SELECT.from.as
        if (existsSubqueryAlias === x.ref?.[0]) return { ref: [outer, ...x.ref.slice(1)] }
        if (x.xpr) x.xpr = x.xpr.map(replaceAliasWithSubqueryAlias)
        return x
      }
      return subq
    }
  }

  function getTransformedOrderByGroupBy(columns, inOrderBy = false) {
    const res = []
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i]
      if (col.isJoinRelevant) {
        const tableAlias$refLink = getQuerySourceName(col)
        const transformedColumn = {
          ref: [tableAlias$refLink, getFullName(col.$refLinks[col.$refLinks.length - 1].definition)],
        }
        if (col.sort) transformedColumn.sort = col.sort
        if (col.nulls) transformedColumn.nulls = col.nulls
        res.push(transformedColumn)
      } else if (pseudos.elements[col.ref?.[0]]) {
        res.push({ ...col })
      } else if (col.ref) {
        if (col.$refLinks.some(link => link.definition._target?.['@cds.persistence.skip'] === true)) continue
        const { target } = col.$refLinks[0]
        const tableAliasName = target.SELECT ? null : getQuerySourceName(col) // do not prepend TA if orderBy column addresses element of query
        const leaf = col.$refLinks[col.$refLinks.length - 1].definition
        if (leaf.virtual === true) continue // already in getFlatColumnForElement
        let baseName
        if (col.ref.length >= 2) {
          // leaf might be intermediate structure
          baseName = col.ref.slice(col.ref[0] === tableAliasName ? 1 : 0, col.ref.length - 1).join('_')
        }
        const flatColumns = getFlatColumnsFor(col, baseName, null, tableAliasName)
        /**
         * We can't guarantee that the element order will NOT change in the future.
         * We claim that the element order doesn't matter, hence we can't allow elements
         * in the order by clause which expand to more than one column, as the order impacts
         * the result.
         */
        if (inOrderBy && flatColumns.length > 1)
          cds.error(`"${getFullName(leaf)}" can't be used in order by as it expands to multiple fields`)
        if (col.nulls) flatColumns[0].nulls = col.nulls
        if (col.sort) flatColumns[0].sort = col.sort
        res.push(...flatColumns)
      } else {
        let transformedColumn
        if (col.SELECT) transformedColumn = transformSubquery(col)
        else if (col.xpr) transformedColumn = { xpr: getTransformedTokenStream(col.xpr) }
        else if (col.func) transformedColumn = { args: getTransformedTokenStream(col.args), func: col.func }
        // val
        else transformedColumn = copy(col)
        if (col.sort) transformedColumn.sort = col.sort
        if (col.nulls) transformedColumn.nulls = col.nulls
        res.push(transformedColumn)
      }
    }
    return res
  }

  function transformSubquery(q) {
    if (q.outerQueries) q.outerQueries.push(inferred)
    else {
      const outerQueries = inferred.outerQueries || []
      outerQueries.push(inferred)
      Object.defineProperty(q, 'outerQueries', { value: outerQueries })
    }
    return cqn4sql(q, model)
  }

  /**
   * Expands wildcard into explicit columns.
   *
   * Based on a queries `$combinedElements`, the flat column representations
   * are calculated and returned. Also prepends the respective table alias on each
   * column. Columns which appear in the `excluding` clause, will be ignored.
   *
   * @param except a list of columns which shall not be included in the wildcard expansion
   * @returns {object[]}
   */
  function getColumnsForWildcard(except = [], replace = []) {
    const wildcardColumns = []
    Object.keys(inferred.$combinedElements).forEach(k => {
      const { index, tableAlias } = inferred.$combinedElements[k][0]
      const element = tableAlias.elements[k]
      // ignore FK for odata csn / ignore blobs from wildcard expansion
      if (isODataFlatForeignKey(element) || (element['@Core.MediaType'] && !element['@Core.IsURL'])) return
      const flatColumns = getFlatColumnsFor(element, null, null, index, [], except, replace)
      wildcardColumns.push(...flatColumns)
    })
    return wildcardColumns

    /**
     * HACK for odata csn input - foreign keys are already part of the elements in this csn flavor
     * not excluding them from the wilcard columns would cause duplicate columns upon foreign key expansion
     * @param {CSN.element} e
     * @returns {boolean} true if the element is a flat foreign key generated by the compiler
     */
    function isODataFlatForeignKey(e) {
      return Boolean(e['@odata.foreignKey4'] || e._foreignKey4)
    }
  }

  /**
   * Resolve `ref` within `def` and return the element
   *
   * @param {string[]} ref
   * @param {CSN.Artifact} def
   * @returns {CSN.Element}
   */
  function getElementForRef(ref, def) {
    return ref.reduce((prev, res) => {
      return prev?.elements?.[res] || prev?._target?.elements[res]
    }, def)
  }

  /**
   * Recursively expand a structured element in flat columns, representing all
   * leaf paths.
   *
   * @param {object} element the structured element which shall be expanded
   * @param {string} baseName the prefixes of the column ref (joined with '_')
   * @param {string} columnAlias the explicit alias which the user has defined for the column.
   *                      `{ struct.foo as bar}` --> `{
   *                                                    struct_foo_leaf1 as bar_foo_leaf1,
   *                                                    struct_foo_leaf2 as bar_foo_leaf2
   *                                                  }`
   * @returns {object[]} flat column(s) for the given element
   * @TODO REVISIT improve this function, it is too complex/generic
   */
  function getFlatColumnsFor(
    column,
    baseName = null,
    columnAlias = null,
    tableAlias = null,
    csnPath = [],
    exclude = [],
    replace = [],
  ) {
    if (!column) return column
    if (column.val || column.func || column.SELECT) return [column]

    const { $refLinks, flatName, isJoinRelevant } = column
    let leafAssoc
    let element = $refLinks ? $refLinks[$refLinks.length - 1].definition : column
    if (element.on) return [] // unmanaged doesn't make it into columns
    else if (element.virtual === true) return []
    else if (!isJoinRelevant && flatName) baseName = flatName
    else if (isJoinRelevant) {
      const leaf = column.$refLinks[column.$refLinks.length - 1]
      leafAssoc = [...column.$refLinks].reverse().find(link => link.definition.isAssociation)
      const { foreignKeys } = leafAssoc.definition
      if (foreignKeys && leaf.alias in foreignKeys) {
        element = leafAssoc.definition
        baseName = getFullName(leafAssoc.definition)
        columnAlias = column.ref.slice(0, -1).map(idOnly).join('_')
      } else baseName = getFullName(column.$refLinks[column.$refLinks.length - 1].definition)
    } else baseName = baseName ? `${baseName}_${element.name}` : getFullName(element)

    // now we have the name of the to be expanded column
    // it could be a structure, an association or a scalar
    // check if the column shall be skipped
    // e.g. for wildcard elements which have been overwritten before
    if (getReplacement(exclude)) return []
    const replacedBy = getReplacement(replace)
    if (replacedBy) {
      // the replacement alias is the baseName of the flat structure
      // e.g. `office.{ *, address.city as floor }`
      // for the `ref: [ office, floor ]` we find the replacement
      // `ref: [ office, address, city]` so the `baseName` of the replacement
      if (replacedBy.as) replacedBy.as = baseName
      // we might have a new base ref
      if (replacedBy.ref && replacedBy.ref.length > 1)
        baseName = getFullName(replacedBy.$refLinks?.[replacedBy.$refLinks.length - 2].definition)
      if (replacedBy.isJoinRelevant)
        // we need to provide the correct table alias
        tableAlias = getQuerySourceName(replacedBy)

      return getFlatColumnsFor(replacedBy, baseName, replacedBy.as, tableAlias, csnPath)
    }

    csnPath.push(element.name)

    if (element.keys) {
      const flatColumns = []
      element.keys.forEach(fk => {
        const fkElement = getElementForRef(fk.ref, element._target)
        let fkBaseName
        if (!leafAssoc || leafAssoc.onlyForeignKeyAccess)
          fkBaseName = `${baseName}_${fk.as || fk.ref[fk.ref.length - 1]}`
        // e.g. if foreign key is accessed via infix filter - use join alias to access key in target
        else fkBaseName = fk.ref[fk.ref.length - 1]
        const fkPath = [...csnPath, fk.ref[fk.ref.length - 1]]
        if (fkElement.elements) {
          // structured key
          Object.values(fkElement.elements).forEach(e => {
            let alias
            if (columnAlias) {
              const fkName = fk.as
                ? `${fk.as}_${e.name}` // foreign key might also be re-named: `assoc { id as foo }`
                : `${fk.ref.join('_')}_${e.name}`
              alias = `${columnAlias}_${fkName}`
            }
            flatColumns.push(...getFlatColumnsFor(e, fkBaseName, alias, tableAlias, [...fkPath], exclude, replace))
          })
        } else if (fkElement.isAssociation) {
          // assoc as key
          flatColumns.push(
            ...getFlatColumnsFor(fkElement, baseName, columnAlias, tableAlias, csnPath, exclude, replace),
          )
        } else {
          // leaf reached
          let flatColumn
          if (columnAlias) flatColumn = { ref: [fkBaseName], as: `${columnAlias}_${fk.ref.join('_')}` }
          else flatColumn = { ref: [fkBaseName] }
          if (tableAlias) flatColumn.ref.unshift(tableAlias)
          Object.defineProperty(flatColumn, 'element', { value: fkElement })
          Object.defineProperty(flatColumn, '_csnPath', { value: csnPath })
          flatColumns.push(flatColumn)
        }
      })
      return flatColumns
    } else if (element.elements) {
      const flatRefs = []
      Object.values(element.elements).forEach(e => {
        const alias = columnAlias ? `${columnAlias}_${e.name}` : null
        flatRefs.push(...getFlatColumnsFor(e, baseName, alias, tableAlias, [...csnPath], exclude, replace))
      })
      return flatRefs
    }
    const flatRef = tableAlias ? { ref: [tableAlias, baseName] } : { ref: [baseName] }
    if (column.cast) {
      flatRef.cast = column.cast
      if (!columnAlias)
        // provide an explicit alias
        columnAlias = baseName
    }
    if (column.sort) flatRef.sort = column.sort
    if (columnAlias) flatRef.as = columnAlias
    Object.defineProperty(flatRef, 'element', { value: element })
    Object.defineProperty(flatRef, '_csnPath', { value: csnPath })
    return [flatRef]

    function getReplacement(from) {
      return from.find(replacement => {
        const nameOfExcludedColumn = replacement.as || replacement.ref?.[replacement.ref.length - 1] || replacement
        return nameOfExcludedColumn === element.name
      })
    }
  }

  /**
   * Walks over token stream such as the array of a `where` or `having`.
   * Expands `exists <assoc>` into `WHERE EXISTS` subqueries and flattens `ref`s.
   * Also applies `cqn4sql` to query expressions found in the token stream.
   *
   * @param {object[]} tokenStream
   * @param {object} $baseLink the environment, where the `ref`s in the token stream are resolvable
   *                           `{…} WHERE exists assoc[exists anotherAssoc]`
   *                           --> the $baseLink for `anotherAssoc` is `assoc`
   */
  function getTransformedTokenStream(tokenStream, $baseLink = null) {
    const transformedWhere = []
    for (let i = 0; i < tokenStream.length; i++) {
      const token = tokenStream[i]
      if (token === 'exists') {
        transformedWhere.push(token)
        const whereExistsSubSelects = []
        const { ref, $refLinks } = tokenStream[i + 1]
        if (!ref) continue
        if (ref[0] in { $self: true, $projection: true })
          cds.error(`Unexpected "${ref[0]}" following "exists", remove it or add a table alias instead`)
        const firstStepIsTableAlias = ref.length > 1 && ref[0] in inferred.sources
        for (let j = 0; j < ref.length; j += 1) {
          let current, next
          const step = ref[j]
          const id = step.id || step
          if (j === 0) {
            if (firstStepIsTableAlias) continue
            current = $baseLink || {
              definition: $refLinks[0].target,
              target: $refLinks[0].target,
              // if the first step of a where is not a table alias,
              // the table alias is the query source where the current ref step
              // originates from. As no table alias is specified, there must be
              // only one table alias for the given ref step
              alias: inferred.$combinedElements[id][0].index,
            }
            next = $refLinks[0]
          } else {
            current = $refLinks[j - 1]
            next = $refLinks[j]
          }

          if (isStructured(next.definition)) {
            // find next association / entity in the ref because this is actually our real nextStep
            const nextAssocIndex =
              2 + $refLinks.slice(j + 2).findIndex(rl => rl.definition.isAssociation || rl.definition.kind === 'entity')
            next = $refLinks[nextAssocIndex]
            j = nextAssocIndex
          }

          const as = getNextAvailableTableAlias(next.alias.split('.').pop())
          next.alias = as
          whereExistsSubSelects.push(getWhereExistsSubquery(current, next, step.where, true))
        }

        const whereExists = { SELECT: whereExistsSubqueries(whereExistsSubSelects) }
        transformedWhere[i + 1] = whereExists
        // skip newly created subquery from being iterated
        i += 1
      } else if (token.list) {
        if (token.list.length === 0) {
          // replace `[not] in <empty list>` to harmonize behavior across dbs
          const precedingTwoTokens = tokenStream.slice(i - 2, i)
          const firstPrecedingToken =
            typeof precedingTwoTokens[0] === 'string' ? precedingTwoTokens[0].toLowerCase() : ''
          const secondPrecedingToken =
            typeof precedingTwoTokens[1] === 'string' ? precedingTwoTokens[1].toLowerCase() : ''

          if (firstPrecedingToken === 'not') {
            transformedWhere.splice(i - 2, 2, 'is', 'not', 'null')
          } else if (secondPrecedingToken === 'in') {
            transformedWhere.splice(i - 1, 1, '=', { val: null })
          } else {
            transformedWhere.push({ list: [] })
          }
        } else {
          transformedWhere.push({ list: getTransformedTokenStream(token.list) })
        }
      } else if (tokenStream.length === 1 && token.val && $baseLink) {
        // infix filter - OData variant w/o mentioning key --> flatten out and compare each leaf to token.val
        const def = $baseLink.definition._target || $baseLink.definition
        const keys = def.keys // use key aspect on entity
        const keyValComparisons = []
        const flatKeys = []
        Object.values(keys)
          // up__ID already part of inner where exists, no need to add it explicitly here
          .filter(k => k !== backlinkFor($baseLink.definition)?.[0])
          .forEach(v => {
            flatKeys.push(...getFlatColumnsFor(v, null, null, $baseLink.alias))
          })
        if (flatKeys.length > 1)
          throw new Error('Filters can only be applied to managed associations which result in a single foreign key')
        flatKeys.forEach(c => keyValComparisons.push([...[c, '=', token]]))
        keyValComparisons.forEach((kv, j) =>
          transformedWhere.push(...kv) && keyValComparisons[j + 1] ? transformedWhere.push('and') : null,
        )
      } else if (token.ref && token.param) {
        transformedWhere.push({ ...token })
      } else if (pseudos.elements[token.ref?.[0]]) {
        transformedWhere.push({ ...token })
      } else {
        // expand `struct = null | struct2`
        const { definition } = token.$refLinks?.[token.$refLinks.length - 1] || {}
        const next = tokenStream[i + 1]
        if (allOps.some(([firstOp]) => firstOp === next) && (definition?.elements || definition?.keys)) {
          const ops = [next]
          let indexRhs = i + 2
          let rhs = tokenStream[i + 2] // either another operator (i.e. `not like` et. al.) or the operand, i.e. the val | null
          if (allOps.some(([, secondOp]) => secondOp === rhs)) {
            ops.push(rhs)
            rhs = tokenStream[i + 3]
            indexRhs += 1
          }
          if (
            isAssocOrStruct(rhs.$refLinks?.[rhs.$refLinks.length - 1].definition) ||
            rhs.val !== undefined ||
            /* unary operator `is null` parsed as string */
            rhs === 'null'
          ) {
            if (notSupportedOps.some(([firstOp]) => firstOp === next))
              cds.error(`The operator "${next}" is not supported for structure comparison`)
            const newTokens = expandComparison(token, ops, rhs)
            const needXpr = Boolean(tokenStream[i - 1] || tokenStream[indexRhs + 1])
            transformedWhere.push(...(needXpr ? [asXpr(newTokens)] : newTokens))
            i = indexRhs // jump to next relevant index
          }
        } else {
          // reject associations in expression, except if we are in an infix filter -> $baseLink is set
          assertNoStructInXpr(token, $baseLink)

          let result = is_regexp(token?.val) ? token : copy(token) // REVISIT: too expensive! //
          if (token.ref) {
            const tableAlias = getQuerySourceName(token, $baseLink)
            if (!$baseLink && token.isJoinRelevant) {
              // t.push(...flatColumns)
              result.ref = [tableAlias, getFullName(token.$refLinks[token.$refLinks.length - 1].definition)]
            } else {
              // revisit: can we get rid of flatName?
              result.ref = [tableAlias, token.flatName]
            }
          } else if (token.SELECT) {
            result = transformSubquery(token)
          } else if (token.xpr) {
            result.xpr = getTransformedTokenStream(token.xpr, $baseLink)
          } else if (token.func && token.args) {
            result.args = token.args.map(t => {
              if (!t.val)
                // this must not be touched
                return getTransformedTokenStream([t], $baseLink)[0]
              return t
            })
          }

          transformedWhere.push(result)
        }
      }
    }
    return transformedWhere
  }

  /**
   * Expand the given definition and compare all leafs to `val`.
   *
   * @param {object} token with $refLinks
   * @param {string} operator one of allOps
   * @param {object} value either `null` or a column (with `ref` and `$refLinks`)
   * @returns {array}
   */
  function expandComparison(token, operator, value) {
    const { definition } = token.$refLinks[token.$refLinks.length - 1]
    let flatRhs
    const result = []
    if (value.$refLinks) {
      // structural comparison
      flatRhs = flattenWithBaseName(value)
    }

    if (flatRhs) {
      const flatLhs = flattenWithBaseName(token)

      //Revisit: Early exit here? We kndow we cant compare the structs, however we do not know exactly why
      //        --> calculate error message or exit early? See test "proper error if structures cannot be compared / too many elements on lhs"
      if (flatRhs.length !== flatLhs.length)
        // make sure we can compare both structures
        cds.error(
          `Can't compare "${definition.name}" with "${
            value.$refLinks[value.$refLinks.length - 1].definition.name
          }": the operands must have the same structure`,
        )
      const pathNotFoundErr = []
      const boolOp = notEqOps.some(([f, s]) => operator[0] === f && operator[1] === s) ? 'or' : 'and'
      const rhsPath = value.ref.join('.') // original path of the comparison, used in error message
      while (flatLhs.length > 0) {
        // retrieve and remove one flat element from LHS and search for it in RHS (remove it there too)
        const { ref, _csnPath: lhs_csnPath } = flatLhs.shift()
        const indexOfElementOnRhs = flatRhs.findIndex(rhs => {
          const { _csnPath: rhs_csnPath } = rhs
          // all following steps must also be part of lhs
          return lhs_csnPath.slice(1).every((val, i) => val === rhs_csnPath[i + 1]) // first step is name of struct -> ignore
        })
        if (indexOfElementOnRhs === -1) {
          pathNotFoundErr.push(`Path "${lhs_csnPath.slice(1).join('.')}" not found in "${rhsPath}"`)
          continue
        }
        const rhs = flatRhs.splice(indexOfElementOnRhs, 1)[0] // remove the element also from RHS
        result.push({ ref }, ...operator, rhs)
        if (flatLhs.length > 0) result.push(boolOp)
      }
      if (flatRhs.length) {
        // if we still have elements in flatRhs -> those were not found in lhs
        const lhsPath = token.ref.join('.') // original path of the comparison, used in error message
        flatRhs.forEach(t => pathNotFoundErr.push(`Path "${t._csnPath.slice(1).join('.')}" not found in "${lhsPath}"`))
        cds.error(`Can't compare "${lhsPath}" with "${rhsPath}": ${pathNotFoundErr.join(', ')}`)
      }
    } else {
      // compare with value
      const flatLhs = flattenWithBaseName(token)
      if (flatLhs.length > 1 && value.val !== null && value !== 'null')
        cds.error(`Can't compare structure "${token.ref.join('.')}" with value "${value.val}"`)
      const boolOp = notEqOps.some(([f, s]) => operator[0] === f && operator[1] === s) ? 'or' : 'and'
      flatLhs.forEach((column, i) => {
        result.push(column, ...operator, value)
        if (flatLhs[i + 1]) result.push(boolOp)
      })
    }
    return result

    function flattenWithBaseName(def) {
      if (!def.$refLinks) return def
      const leaf = def.$refLinks[def.$refLinks.length - 1]
      const first = def.$refLinks[0]
      const tableAlias = getQuerySourceName(def, def.ref.length > 1 && first.definition.isAssociation ? first : null)
      if (leaf.definition.parent.kind !== 'entity')
        // we need the base name
        return getFlatColumnsFor(leaf.definition, def.ref.slice(0, def.ref.length - 1).join('_'), null, tableAlias)
      return getFlatColumnsFor(leaf.definition, null, null, tableAlias)
    }
  }

  function assertNoStructInXpr(token, inInfixFilter = false) {
    if (!inInfixFilter && token.$refLinks?.[token.$refLinks.length - 1].definition.target)
      // revisit: let this through if not requested otherwise
      rejectAssocInExpression()
    if (isStructured(token.$refLinks?.[token.$refLinks.length - 1].definition))
      // revisit: let this through if not requested otherwise
      rejectStructInExpression()

    function rejectAssocInExpression() {
      throw new Error(/An association can't be used as a value in an expression/)
    }
    function rejectStructInExpression() {
      throw new Error(/A structured element can't be used as a value in an expression/)
    }
  }

  /**
   * Recursively walks over all `from` args. Association steps in the `ref`s
   * are transformed into `WHERE exists` subqueries. The given `from.ref`s
   * are always of length == 1 after processing.
   *
   * The steps in a `ref` are processed in reversed order. This is the main difference
   * to the `WHERE exists` expansion in the @function getTransformedTokenStream().
   *
   * @param {object} from
   * @param {object[]?} existingWhere custom where condition which is appended to the filter
   *                                  conditions of the resulting `WHERE exists` subquery
   */
  function getTransformedFrom(from, existingWhere = []) {
    const transformedWhere = []
    let transformedFrom = copy(from) // REVISIT: too expensive!
    if (from.$refLinks)
      Object.defineProperty(transformedFrom, '$refLinks', { value: [...from.$refLinks], writable: true })
    if (from.args) {
      transformedFrom.args = []
      from.args.forEach(arg => {
        if (arg.SELECT) {
          const { whereExists: e, transformedFrom: f } = getTransformedFrom(arg.SELECT.from, arg.SELECT.where)
          const transformedArg = { SELECT: { from: f, where: e } }
          transformedFrom.args.push(transformedArg)
        } else {
          const { transformedFrom: f } = getTransformedFrom(arg)
          transformedFrom.args.push(f)
        }
      })
      return { transformedFrom }
    } else if (from.SELECT) {
      transformedFrom = transformSubquery(from)
      if (from.as)
        // preserve explicit TA
        transformedFrom.as = from.as
      return { transformedFrom }
    } else {
      return _transformFrom()
    }
    function _transformFrom() {
      if (typeof from === 'string') {
        // normalize to `ref`, i.e. for `UPDATE.entity('bookshop.Books')`
        return { transformedFrom: { ref: [from], as: from.split('.').pop() } }
      }
      transformedFrom.as =
        from.as || transformedFrom.$refLinks[transformedFrom.$refLinks.length - 1].definition.name.split('.').pop()
      const whereExistsSubSelects = []
      const filterConditions = []
      const refReverse = [...from.ref].reverse()
      const $refLinksReverse = [...transformedFrom.$refLinks].reverse()
      for (let i = 0; i < refReverse.length; i += 1) {
        const stepLink = $refLinksReverse[i]

        let nextStepLink = $refLinksReverse[i + 1]
        const nextStep = refReverse[i + 1] // only because we want the filter condition

        if (stepLink.definition.target && nextStepLink) {
          const { where } = nextStep
          if (isStructured(nextStepLink.definition)) {
            // find next association / entity in the ref because this is actually our real nextStep
            const nextStepIndex =
              2 +
              $refLinksReverse
                .slice(i + 2)
                .findIndex(rl => rl.definition.isAssociation || rl.definition.kind === 'entity')
            nextStepLink = $refLinksReverse[nextStepIndex]
          }
          const as = getNextAvailableTableAlias(nextStepLink.alias.split('.').pop())
          nextStepLink.alias = as
          whereExistsSubSelects.push(getWhereExistsSubquery(stepLink, nextStepLink, where))
        }
      }

      // only append infix filter to outer where if it is the leaf of the from ref
      if (refReverse[0].where)
        filterConditions.push(getTransformedTokenStream(refReverse[0].where, $refLinksReverse[0]))

      if (existingWhere.length > 0) filterConditions.push(existingWhere)
      if (whereExistsSubSelects.length > 0) {
        const { definition: leafAssoc, alias } = transformedFrom.$refLinks[transformedFrom.$refLinks.length - 1]
        Object.assign(transformedFrom, {
          ref: [leafAssoc.target],
          as: alias,
        })
        transformedWhere.push(...['exists', { SELECT: whereExistsSubqueries(whereExistsSubSelects) }])
        filterConditions.forEach(f => {
          transformedWhere.push('and')
          if (filterConditions.length > 1) transformedWhere.push(asXpr(f))
          else if (f.length > 3) transformedWhere.push(asXpr(f))
          else transformedWhere.push(...f)
        })
      } else {
        if (filterConditions.length > 0) {
          filterConditions.reverse().forEach((f, index) => {
            if (filterConditions.length > 1) transformedWhere.push(asXpr(f))
            else transformedWhere.push(...f)
            if (filterConditions[index + 1] !== undefined) transformedWhere.push('and')
          })
        }
      }

      // adjust ref & $refLinks after associations have turned into where exists subqueries
      transformedFrom.$refLinks.splice(0, transformedFrom.$refLinks.length - 1)
      transformedFrom.ref = [localized(transformedFrom.$refLinks[0].target)]

      return { transformedWhere, transformedFrom }
    }
  }

  function whereExistsSubqueries(whereExistsSubSelects) {
    if (whereExistsSubSelects.length === 1) return whereExistsSubSelects[0]
    whereExistsSubSelects.reduce((prev, cur) => {
      if (prev.where) {
        prev.where.push('and', 'exists', { SELECT: cur })
        return cur
      } else {
        prev = cur
      }
      return prev
    }, {})
    return whereExistsSubSelects[0]
  }

  function getNextAvailableTableAlias(id) {
    return inferred.joinTree.addNextAvailableTableAlias(id)
  }

  function asXpr(thing) {
    return { xpr: thing }
  }

  /**
   * @param {CSN.Element} elt
   * @returns {boolean}
   */
  function isStructured(elt) {
    return Boolean(elt?.elements && elt.kind === 'element')
  }

  /**
   * @param {CSN.Element} elt
   * @returns {boolean}
   */
  function isAssocOrStruct(elt) {
    return elt?.keys || (elt?.elements && elt.kind === 'element')
  }

  /**
   * Calculates which elements are the backlinks of a $self comparison in a
   * given on-condition. That are the managed associations in the target of the
   * given association.
   *
   * @param {CSN.Association} assoc with on-condition
   * @returns {[CSN.Association] | null} all assocs which are compared to `$self`
   */
  function backlinkFor(assoc) {
    if (!assoc.on) return null
    const target = model.definitions[assoc.target]
    // technically we could have multiple backlinks
    const backlinks = []
    for (let i = 0; i < assoc.on.length; i += 3) {
      const lhs = assoc.on[i]
      const rhs = assoc.on[i + 2]
      if (lhs?.ref?.length === 1 && lhs.ref[0] === '$self') backlinks.push(rhs)
      else if (rhs?.ref?.length === 1 && rhs.ref[0] === '$self') backlinks.push(lhs)
    }
    return backlinks.map(each =>
      getElementForRef(
        each.ref.slice(1),
        each.ref[0] in { $self: true, $projection: true } ? getParentEntity(assoc) : target,
      ),
    )

    function getParentEntity(element) {
      if (element.kind === 'entity') return element
      else return getParentEntity(element.parent)
    }
  }

  /**
   * Calculates the on-condition for the given (un-)managed association.
   *
   * @param {$refLink} assocRefLink with on-condition
   * @param {$refLink} targetSideRefLink the reflink which has the target alias of the association
   * @returns {[CSN.Association] | null} all assocs which are compared to `$self`
   */
  function onCondFor(assocRefLink, targetSideRefLink, inWhereOrJoin) {
    const { on, keys } = assocRefLink.definition
    const target = model.definitions[assocRefLink.definition.target]
    let res
    // technically we could have multiple backlinks
    if (keys) {
      const fkPkPairs = getParentKeyForeignKeyPairs(assocRefLink.definition, targetSideRefLink, true)
      const transformedOn = []
      fkPkPairs.forEach((pair, i) => {
        const { sourceSide, targetSide } = pair
        sourceSide.ref.unshift(assocRefLink.alias)
        transformedOn.push(sourceSide, '=', targetSide)
        if (fkPkPairs[i + 1]) transformedOn.push('and')
      })
      res = transformedOn
    } else if (on) {
      res = calculateOnCondition(on)
    }
    return res

    /**
     * For an unmanaged association, calculate the proper on-condition.
     * For a `$self = assoc.<backlink>` comparison, the three tokens are replaced
     * by the on-condition of the <backlink>.
     *
     *
     * @param {on} tokenStream the on condition of the unmanaged association
     * @returns the final on-condition for the unmanaged association
     */
    function calculateOnCondition(tokenStream) {
      const result = copy(tokenStream) // REVISIT: too expensive!
      for (let i = 0; i < result.length; i += 1) {
        const lhs = result[i]
        if (lhs.xpr) {
          const xpr = calculateOnCondition(lhs.xpr)
          result[i] = asXpr(xpr)
          continue
        }
        const rhs = result[i + 2]
        let backlink
        if (rhs?.ref && lhs?.ref) {
          if (lhs?.ref?.length === 1 && lhs.ref[0] === '$self')
            backlink = getElementForRef(
              rhs.ref.slice(1),
              rhs.ref[0] in { $self: true, $projection: true } ? getParentEntity(assocRefLink.definition) : target,
            )
          else if (rhs?.ref?.length === 1 && rhs.ref[0] === '$self')
            backlink = getElementForRef(
              lhs.ref.slice(1),
              lhs.ref[0] in { $self: true, $projection: true } ? getParentEntity(assocRefLink.definition) : target,
            )
          else {
            // if we have refs on each side of the comparison, we might need to perform tuple expansion
            // or flatten the structures
            // REVISIT: this whole section needs a refactoring, it is too complex and some edge cases may still be not considered...
            const refLinkFaker = thing => {
              const { ref } = thing
              const assocHost = getParentEntity(assocRefLink.definition)
              Object.defineProperty(thing, '$refLinks', {
                value: [],
                writable: true,
              })
              ref.reduce((prev, res, i) => {
                if (res === '$self')
                  // next is resolvable in entity
                  return prev
                const definition = prev?.elements?.[res] || prev?._target?.elements[res] || pseudos.elements[res]
                const target = getParentEntity(definition)
                thing.$refLinks[i] = { definition, target, alias: definition.name }
                return prev?.elements?.[res] || prev?._target?.elements[res] || pseudos.elements[res]
              }, assocHost)
            }

            // comparison in on condition needs to be expanded...
            // re-use existing algorithm for that
            // we need to fake some $refLinks for that to work though...
            lhs?.ref && refLinkFaker(lhs)
            rhs?.ref && refLinkFaker(rhs)
            const lhsLeafArt = lhs.ref && lhs.$refLinks[lhs.$refLinks.length - 1].definition
            const rhsLeafArt = rhs.ref && rhs.$refLinks[rhs.$refLinks.length - 1].definition
            if (lhsLeafArt?.target || rhsLeafArt?.target) {
              if (rhs.$refLinks[0].definition !== assocRefLink.definition) {
                rhs.ref.unshift(targetSideRefLink.alias)
                rhs.$refLinks.unshift(targetSideRefLink)
              }
              if (lhs.$refLinks[0].definition !== assocRefLink.definition) {
                lhs.ref.unshift(targetSideRefLink.alias)
                lhs.$refLinks.unshift(targetSideRefLink)
              }
              const expandedComparison = getTransformedTokenStream([lhs, result[i + 1], rhs])
              const res = tokenStream[i + 3] ? [asXpr(expandedComparison)] : expandedComparison
              result.splice(i, 3, ...res)
              i += res.length
              continue
            }
            // naive assumption: if first step is the association itself, all following ref steps must be resolvable
            // within target `assoc.assoc.fk` -> `assoc.assoc_fk`
            else if (
              lhs.$refLinks[0].definition ===
              getParentEntity(assocRefLink.definition).elements[assocRefLink.definition.name]
            )
              result[i].ref = [result[i].ref[0], lhs.ref.slice(1).join('_')]
            // naive assumption: if the path starts with an association which is not the association from
            // which the on-condition originates, it must be a foreign key and hence resolvable in the source
            else if (lhs.$refLinks[0].definition.target) result[i].ref = [result[i].ref.join('_')]
          }
        }
        if (backlink) {
          const wrapInXpr = result[i + 3] || result[i - 1] // if we have a complex on-condition, wrap each part in xpr
          let backlinkOnCondition = []
          if (backlink.on) {
            // unmanaged backlink -> prepend correct aliases
            backlinkOnCondition = backlink.on.map(t => {
              if (t.ref?.length > 1 && t.ref[0] === (backlink.name || targetSideRefLink.definition.name)) {
                return { ref: [targetSideRefLink.alias, ...t.ref.slice(1)] }
              } else if (t.ref) {
                if (t.ref.length > 1 && !(t.ref[0] in pseudos.elements))
                  return { ref: [assocRefLink.alias, ...t.ref.slice(1)] }
                else return { ref: [assocRefLink.alias, ...t.ref] }
              } else {
                return t
              }
            })
          } else if (backlink.keys) {
            // managed backlink -> calculate fk-pk pairs
            const fkPkPairs = getParentKeyForeignKeyPairs(backlink, targetSideRefLink)
            fkPkPairs.forEach((pair, j) => {
              const { sourceSide, targetSide } = pair
              sourceSide.ref.unshift(assocRefLink.alias)
              backlinkOnCondition.push(sourceSide, '=', targetSide)
              if (!inWhereOrJoin) backlinkOnCondition.reverse()
              if (fkPkPairs[j + 1]) backlinkOnCondition.push('and')
            })
          }
          result.splice(i, 3, ...(wrapInXpr ? [asXpr(backlinkOnCondition)] : backlinkOnCondition))
          i += wrapInXpr ? 1 : backlinkOnCondition.length // skip inserted tokens
        } else if (lhs.ref) {
          if (lhs.ref[0] === '$self') result[i].ref.splice(0, 1, targetSideRefLink.alias)
          else if (lhs.ref.length > 1) {
            if (
              !(lhs.ref[0] in pseudos.elements) &&
              lhs.ref[0] !== assocRefLink.alias &&
              lhs.ref[0] !== targetSideRefLink.alias
            ) {
              // we need to find correct table alias for the structured access
              const { definition } = lhs.$refLinks[0]
              if (definition === assocRefLink.definition) {
                // first step is the association itself -> use it's name as it becomes the table alias
                result[i].ref.splice(0, 1, assocRefLink.alias)
              } else if (
                Object.values(
                  targetSideRefLink.definition.elements || targetSideRefLink.definition._target.elements,
                ).some(e => e === definition)
              ) {
                // first step is association which refers to its foreign key by dot notation
                result[i].ref = [targetSideRefLink.alias, lhs.ref.join('_')]
              }
            }
          } else if (lhs.ref.length === 1) result[i].ref.unshift(targetSideRefLink.alias)
        }
      }
      return result
    }
    /**
     * Recursively calculates the containing entity for a given element.
     *
     * @param {CSN.element} element
     * @returns {CSN.definition} the entity containing the given element
     */
    function getParentEntity(element) {
      if (!element.kind)
        // pseudo element
        return element
      if (element.kind === 'entity') return element
      else return model.definitions[localized(getParentEntity(element.parent))]
    }
  }

  /**
   * For a given managed association, calculate the foreign key - parent key tuples.
   *
   * @param {CDS.Association} assoc the association for which the on condition shall be calculated
   * @param {object} targetSideRefLink the reflink which has the target alias of the (backlink) association
   * @param {boolean} flipSourceAndTarget target and source side are flipped in the where exists subquery
   * @returns {[{sourceSide: {ref: []}, targetSide: {ref:[]}}]} array of source side - target side reference tuples, i.e. the foreign keys and parent keys.
   */
  function getParentKeyForeignKeyPairs(assoc, targetSideRefLink, flipSourceAndTarget = false) {
    const res = []
    const backlink = backlinkFor(assoc)?.[0]
    const { keys, _target } = backlink || assoc
    if (keys) {
      keys.forEach(fk => {
        const { ref, as } = fk
        const elem = getElementForRef(ref, _target) // find the element (the target element of the foreign key) in the target of the (backlink) association
        const flatParentKeys = getFlatColumnsFor(elem, ref.slice(0, ref.length - 1).join('_')) // it might be a structured element, so expand it into the full parent key tuple
        const flatAssociationName = getFullName(backlink || assoc) // get the name of the (backlink) association
        const flatForeignKeys = getFlatColumnsFor(elem, flatAssociationName, as) // the name of the (backlink) association is the base of the foreign key tuple, also respect aliased fk.

        for (let i = 0; i < flatForeignKeys.length; i++) {
          if (flipSourceAndTarget) {
            // `where exists <assoc>` expansion
            // a backlink will cause the foreign key to be on the source side
            const refInTarget = backlink ? flatParentKeys[i] : flatForeignKeys[i]
            const refInSource = backlink ? flatForeignKeys[i] : flatParentKeys[i]
            res.push({
              sourceSide: refInSource,
              targetSide: {
                ref: [
                  targetSideRefLink.alias,
                  refInTarget.as ? `${flatAssociationName}_${refInTarget.as}` : refInTarget.ref[0],
                ],
              },
            })
          } else {
            // `select from <assoc>` to `where exists` expansion
            // a backlink will cause the foreign key to be on the target side
            const refInTarget = backlink ? flatForeignKeys[i] : flatParentKeys[i]
            const refInSource = backlink ? flatParentKeys[i] : flatForeignKeys[i]
            res.push({
              sourceSide: {
                ref: [refInSource.as ? `${flatAssociationName}_${refInSource.as}` : refInSource.ref[0]],
              },
              targetSide: { ref: [targetSideRefLink.alias, ...refInTarget.ref] },
            })
          }
        }
      })
    }
    return res
  }

  /**
   * Constructs a where exists subquery for a given association - i.e. calculates foreign key / parent key
   * relations for the association.
   *
   * @param {$refLink} current step of the association path
   * @param {$refLink} next step of the association path
   * @param {object[]} customWhere infix filter which must be part of the where exists subquery on condition
   * @param {boolean} inWhere whether or not the path is part of the queries where clause
   *                    -> if it is, target and source side are flipped in the where exists subquery
   * @returns {CQN.SELECT}
   */
  function getWhereExistsSubquery(current, next, customWhere = null, inWhere = false) {
    const { definition } = current
    const { definition: nextDefinition } = next
    const on = []
    const fkSource = inWhere ? nextDefinition : definition
    // TODO: use onCondFor()
    if (fkSource.keys) {
      const pkFkPairs = getParentKeyForeignKeyPairs(fkSource, current, inWhere)
      pkFkPairs.forEach((pkFkPair, i) => {
        const { targetSide, sourceSide } = pkFkPair
        sourceSide.ref.unshift(next.alias)
        if (i > 0) on.push('and')
        on.push(sourceSide, '=', targetSide)
      })
    } else {
      const unmanagedOn = onCondFor(inWhere ? next : current, inWhere ? current : next, inWhere)
      on.push(...(customWhere && hasLogicalOr(unmanagedOn) ? [asXpr(unmanagedOn)] : unmanagedOn))
    }
    // infix filter conditions are wrapped in `xpr` when added to the on-condition
    if (customWhere) {
      const filter = getTransformedTokenStream(customWhere, next)
      on.push(...['and', ...(hasLogicalOr(filter) ? [asXpr(filter)] : filter)])
    }

    const SELECT = {
      from: {
        ref: [localized(assocTarget(nextDefinition) || nextDefinition)],
        as: next.alias,
      },
      columns: [
        {
          val: 1,
          // as: 'dummy'
        },
      ],
      where: on,
    }
    return SELECT
  }

  /**
   * If the query is `localized`, return the name of the `localized` entity for the `definition`.
   * If there is no `localized` entity for the `definition`, return the name of the `definition`
   *
   * @param {CSN.definition} definition
   * @returns the name of the localized entity for the given `definition` or `definition.name`
   */
  function localized(definition) {
    if (!isLocalized(definition)) return definition.name
    const view = model.definitions[`localized.${definition.name}`]
    return view?.name || definition.name
  }

  /**
   * If a given query is required to be translated, the query has
   * the `.localized` property set to `true`. If that is the case,
   * and the definition has not set the `@cds.localized` annotation
   * to `false`, the given definition must be translated.
   *
   * @returns true if the given definition shall be localized
   */
  function isLocalized(definition) {
    return inferred.SELECT?.localized && definition['@cds.localized'] !== false
  }

  /**
   * Get the csn definition of the target of a given association
   *
   * @param assoc
   * @returns the csn definition of the association target or null if it is not an association
   */
  function assocTarget(assoc) {
    return model.definitions[assoc.target] || null
  }

  /**
   * Calculate the flat name for a deeply nested element:
   * @example `entity E { struct: { foo: String} }` => `getFullName(foo)` => `struct_foo`
   *
   * @param {CSN.element} node an element
   * @param {object} name the last part of the name, e.g. the name of the deeply nested element
   * @returns the flat name of the element
   */
  function getFullName(node, name = node.name) {
    if (node.parent.kind === 'entity') return name

    return getFullName(node.parent, `${node.parent.name}_${name}`)
  }

  /**
   * Calculates the name of the source which can be used to address the given node.
   *
   * @param {object} node a csn object with a `ref` and `$refLinks`
   * @param {object} $baseLink optional base `$refLink`, e.g. for infix filters.
   *                           For an infix filter, we must explicitly pass the TA name
   *                           because the first step of the ref might not be part of
   *                           the combined elements of the query
   * @returns the source name which can be used to address the node
   */
  function getQuerySourceName(node, $baseLink = null) {
    if (!node || !node.$refLinks || !node.ref) {
      throw new Error('Invalid node')
    }
    if ($baseLink) {
      return getBaseLinkAlias($baseLink)
    }

    if (node.isJoinRelevant) {
      return getJoinRelevantAlias(node)
    }

    return getSelectOrEntityAlias(node) || getCombinedElementAlias(node)
    function getBaseLinkAlias($baseLink) {
      return $baseLink.alias
    }

    function getJoinRelevantAlias(node) {
      return [...node.$refLinks]
        .reverse()
        .find($refLink => $refLink.definition.isAssociation && !$refLink.onlyForeignKeyAccess).alias
    }

    function getSelectOrEntityAlias(node) {
      let firstRefLink = node.$refLinks[0].definition
      if (firstRefLink.SELECT || firstRefLink.kind === 'entity') {
        return node.ref[0]
      }
    }

    function getCombinedElementAlias(node) {
      return inferred.$combinedElements[node.ref[0].id || node.ref[0]][0].index.split('.').pop()
    }
  }
}

module.exports = Object.assign(cqn4sql, {
  // for own tests only:
  eqOps,
  notEqOps,
  notSupportedOps,
})

function copy(obj) {
  const walk = function (par, prop) {
    const val = prop ? par[prop] : par

    // If value is native return
    if (typeof val !== 'object' || val == null || val instanceof RegExp || val instanceof Date || val instanceof Buffer)
      return val

    const ret = Array.isArray(val) ? [] : {}
    Object.keys(val).forEach(k => {
      ret[k] = walk(val, k)
    })
    return ret
  }

  return walk(obj)
}

function hasLogicalOr(tokenStream) {
  return tokenStream.some(t => t in { OR: true, or: true })
}
const idOnly = ref => ref.id || ref
const is_regexp = x => x?.constructor?.name === 'RegExp' // NOTE: x instanceof RegExp doesn't work in repl