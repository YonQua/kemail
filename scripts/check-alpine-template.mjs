const IDENTIFIER = /^[A-Za-z_$][\w$]*$/
const PROPERTY_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/
const VALUE_DIRECTIVES = new Set(['x-data', 'x-if', 'x-show', 'x-text', 'x-html', 'x-init', 'x-effect'])

function supportsCspBinding(name, value) {
  const directive = name.split('.')[0]
  if (directive === 'x-cloak' || directive === 'x-ignore') return value === ''
  if (directive === 'x-ref') return IDENTIFIER.test(value)
  if (directive === 'x-for') {
    const loop = value.match(/^([A-Za-z_$][\w$]*)\s+in\s+(.+)$/)
    return Boolean(loop && PROPERTY_PATH.test(loop[2]))
  }
  if (name.startsWith('@') || name.startsWith('x-on:')) {
    return value === '' || PROPERTY_PATH.test(value)
  }
  if (VALUE_DIRECTIVES.has(directive) || name.startsWith(':') || name.startsWith('x-bind:')) {
    return PROPERTY_PATH.test(value)
  }
  return false
}

// A scanner for this repository's templates, not a general HTML parser.
// Quoted attributes share one tokenizer; raw script/style contents are skipped.
function* alpineBindings(html) {
  const tags = /<!--[\s\S]*?-->|<[A-Za-z][\w:-]*(?:"[^"]*"|'[^']*'|[^'">])*>/g
  let match
  while ((match = tags.exec(html))) {
    const tag = match[0]
    if (tag.startsWith('<!--')) continue
    const opening = tag.match(/^<([\w:-]+)/)
    const attrs = /([^\s=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
    attrs.lastIndex = opening[0].length
    let attr
    while ((attr = attrs.exec(tag))) {
      const name = attr[1].toLowerCase()
      if (name.startsWith('x-') || name.startsWith(':') || name.startsWith('@')) {
        yield {
          name,
          value: attr[2] ?? attr[3] ?? attr[4] ?? '',
          offset: match.index + attr.index,
        }
      }
    }
    if (/^(script|style)$/i.test(opening[1])) {
      const closing = new RegExp(`</${opening[1]}\\s*>`, 'gi')
      closing.lastIndex = tags.lastIndex
      const end = closing.exec(html)
      tags.lastIndex = end ? closing.lastIndex : html.length
    }
  }
}

// Alpine CSP 3.14.9 only resolves property paths. This checks syntax, not whether
// a referenced property exists or the page behaves correctly at runtime.
export function checkAlpineTemplate(html, filename) {
  for (const { name, value, offset } of alpineBindings(html)) {
    if (supportsCspBinding(name, value)) continue
    const line = html.slice(0, offset).split('\n').length
    throw new Error(`${filename}:${line}: ${name}="${value}" 不符合项目的 Alpine CSP 3.14.9 模板规则；请使用属性/getter 或方法引用，新指令需先审核。`)
  }
}
