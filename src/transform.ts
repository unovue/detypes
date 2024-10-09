import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import type {
  TransformOptions as BabelTransformOptions,
} from '@babel/core'
import {
  transformAsync,
} from '@babel/core'
import type { Node, VisitNodeObject } from '@babel/traverse'
import { format } from 'prettier'
import type {
  SFCScriptBlock,
} from '@vue/compiler-sfc'
import {
  MagicString,
  compileScript,
  parse,
  registerTS,
} from '@vue/compiler-sfc'
import {
  isComponentNode as isVueComponentNode,
  isSimpleExpressionNode as isVueSimpleExpressionNode,
  traverse as traverseVueAst,
} from '@vuedx/template-ast-types'
// @ts-expect-error: No typinggs needed
import babelTs from '@babel/preset-typescript'
import type { PrettierOptions } from '.'

function getDefinePropsObject(content: string) {
  const matched = /\sprops:\s*\{/m.exec(content)
  if (matched) {
    const startContentIndex = matched.index + matched[0].length - 1
    let leftBracketCount = 1
    let endContentIndex = startContentIndex + 1
    while (leftBracketCount) {
      if (content.charAt(endContentIndex) === '{')
        leftBracketCount++
      else if (content.charAt(endContentIndex) === '}')
        leftBracketCount--

      endContentIndex++
    }
    return content.substring(startContentIndex, endContentIndex)
  }
  return ''
}

export interface RemoveTypeOptions {
/** Whether to remove ts-ignore and ts-expect-error comments */
  removeTsComments?: boolean
  /** Escape hatch for customizing Babel configuration */
  customizeBabelConfig?: (config: BabelTransformOptions) => void
}

export interface TransformOptions extends RemoveTypeOptions {
/** Prettier options */
  prettierOptions?: PrettierOptions | null
}

/**
 * Transform TypeScript code into vanilla JavaScript without affecting the formatting
 * @param code            Source coude
 * @param fileName        File name for the source
 * @param options         Options
 */
export async function transform(
  code: string,
  fileName: string,
  options: TransformOptions = {},
): Promise<string> {
  const { prettierOptions, ...removeTypeOptions } = options

  const originalFileName = fileName

  code = code.replaceAll('\r\n', '\n')

  if (fileName.endsWith('.vue'))
    code = await transformVue(code, fileName, options)

  else
    code = await removeTypes(code, fileName, removeTypeOptions)

  return await format(code, {
    ...prettierOptions,
    filepath: originalFileName,
  })
}

export async function transformVue(
  code: string,
  fileName: string,
  options: TransformOptions = {},
) {
  const parsedVue = parse(code)

  if (
    parsedVue.descriptor.script?.lang !== 'ts'
    && parsedVue.descriptor.scriptSetup?.lang !== 'ts'
  ) {
    // No TypeScript, don't touch it
    return code
  }

  const { script: script1, scriptSetup: script2 } = parsedVue.descriptor

  /**
   * Check if the script contains defineProps or defineEmits
   * If it does, we need to extract the props and emits from compiled code
   */
  let propsContent = ''
  let emitsContent = ''
  const isContainsDefinePropsType = script2?.content.match(/defineProps\s*</m)
  const isContainsDefineEmitType = script2?.content.match(/defineEmits\s*</m)
  if (isContainsDefinePropsType || isContainsDefineEmitType) {
    const typescript = await import('typescript')
    registerTS(() => typescript.default)

    const resolveFile = (file: string) => {
      return resolve(
        isAbsolute(file) || file.startsWith('node_modules')
          ? ''
          : dirname(fileName),
        file,
      )
    }

    const { content } = compileScript(parsedVue.descriptor, {
      id: fileName,
      fs: {
        fileExists(file: string) {
          return !!statSync(resolveFile(file), {
            throwIfNoEntry: false,
          })?.isFile()
        },
        readFile: (file: string) => {
          return readFileSync(resolveFile(file)).toString()
        },
      },
    })

    if (isContainsDefinePropsType)
      propsContent = getDefinePropsObject(content)

    if (isContainsDefineEmitType)
      emitsContent = content.match(/\semits:\s(\[.*\]?)/m)?.[1] || ''
  }

  const removeVueSfcScriptOptions: Omit<TransformOptions, 'prettierOptions'> = {
    ...options,
    customizeBabelConfig(config) {
      config.plugins ||= []
      config.plugins?.push({
        name: 'detype-remove-with-defaults',
        visitor: {
          CallExpression(path) {
            const callee = path.get('callee')
            if (callee.isIdentifier()) {
              if (callee.node.name === 'defineProps') {
                const parentPath = path.parentPath
                if (parentPath.isCallExpression()) {
                  const callee = parentPath.get('callee')
                  if (
                    callee.isIdentifier()
                    && callee.node.name === 'withDefaults'
                  ) {
                    parentPath.replaceWith(path.node)
                    parentPath.stop()
                  }
                }
              }
            }
          },
        },
      })
      options.customizeBabelConfig?.(config)
    },
  }

  const ms = new MagicString(code)

  // Remove types from expressions in the template
  const locs: Array<[number, number]> = []
  const expressionCodeList: Array<string> = []
  const template = parsedVue.descriptor.template
  let expressionCode = ''
  if (template?.ast) {
    traverseVueAst(template.ast as any, {
      enter(node) {
        if (isVueSimpleExpressionNode(node) && !node.isStatic) {
          const ForOfOrInRE = /\s+(of|in)\s+/
          if (node.content.match(ForOfOrInRE)) {
            const parts = node.content.split(ForOfOrInRE)
            if (parts.length === 3) {
              const content = parts[parts.length - 1]
              expressionCodeList.push(content)
              locs.push([node.loc.start.offset + node.content.length - content.length, node.loc.end.offset])
            }
            else {
              expressionCodeList.push(node.content)
              locs.push([node.loc.start.offset, node.loc.end.offset])
            }
          }
          else {
            expressionCodeList.push(node.loc.source)
            locs.push([node.loc.start.offset, node.loc.end.offset])
          }
        }
        else if (isVueComponentNode(node)) {
          const content = node.tag
          expressionCodeList.push(node.tag)
          let start = node.loc.start.offset + 1
          locs.push([start, start += content.length])
        }
      },
    })

    const delimiter = `['---detypes-delimiter---'];`
    expressionCode = (await removeTypes(expressionCodeList.map(c => `[${c}]`).join(`;${delimiter}`), `${fileName}.ts`, options))
    const lines = expressionCode.split(delimiter)
    for (let i = 0; i < locs.length; i++) {
      const loc = locs[i]
      const line = lines[i].trim()
      ms.update(loc[0], loc[1], line.substring(1, line.length - 2))
    }
  }

  for (const script of [script1, script2].filter(Boolean)) {
    code = await removeTypesFromVueSfcScript(
      expressionCode,
      fileName,
      script!,
      removeVueSfcScriptOptions,
    )
    if (script?.attrs.generic)
      ms.replace(` generic="${script!.attrs.generic}"`, '')

    ms.update(script!.loc.start.offset, script!.loc.end.offset, code)
  }

  // We have to backtrack to remove lang="ts", not fool-proof but should work for all reasonable code
  ms.replaceAll(/\blang\s*=\s*["']ts["']/g, '')

  let result = ms.toString()
  if (propsContent)
    result = result.replace('defineProps(', str => `${str}${propsContent}`)

  if (emitsContent)
    result = result.replace('defineEmits(', str => `${str}${emitsContent}`)

  return result
}

async function removeTypes(
  code: string,
  fileName: string,
  options: RemoveTypeOptions,
) {
// We want to collapse newline runs created by removing types while preserving
// newline runes in the original code. This is especially important for
// template literals, which can contain literal newlines.
// Keep track of how many newlines in a newline run were replaced.
  code = code.replace(
    /\n\n+/g,
    match => `\n/* @detype: empty-line=${match.length} */\n`,
  )
  code = processMagicComments(code)

  // Babel visitor to remove leading comments
  const removeComments: VisitNodeObject<unknown, Node> = {
    enter(p) {
      if (!p.node.leadingComments)
        return

      for (let i = p.node.leadingComments.length - 1; i >= 0; i--) {
        const comment = p.node.leadingComments[i]

        if (
          code.slice(comment.end).match(/^\s*\n\s*\n/)
          || comment.value.includes('@detype: empty-line')
        ) {
          // There is at least one empty line between the comment and the TypeScript specific construct
          // We should keep this comment and those before it
          break
        }
        comment.value = '@detype: remove-me'
      }
    },
  }

  const babelConfig: BabelTransformOptions = {
    filename: fileName,
    retainLines: true,
    plugins: [
      // Plugin to remove leading comments attached to TypeScript-only constructs
      {
        name: 'detype-comment-remover',
        visitor: {
          TSTypeAliasDeclaration: removeComments,
          TSInterfaceDeclaration: removeComments,
          TSDeclareFunction: removeComments,
          TSDeclareMethod: removeComments,
          TSImportType: removeComments,
        },
      },
    ].filter(Boolean),
    presets: [babelTs],
    generatorOpts: {
      shouldPrintComment: comment =>
        comment !== '@detype: remove-me'
        && (!options.removeTsComments
        || !comment.match(/^\s*(@ts-ignore|@ts-expect-error)/)),
    },
  }

  if (options.customizeBabelConfig)
    options.customizeBabelConfig(babelConfig)

  const babelOutput = await transformAsync(code, babelConfig)

  if (
    !babelOutput
    || babelOutput.code === undefined
    || babelOutput.code === null
  )
    throw new Error('Babel error')

  return (
    babelOutput.code
      .replaceAll(/\n\n*/g, '\n')
    // Subtract 2 from the newline count because we inserted two surrounding
    // newlines when we initially created the detype: empty-line comment.
      .replace(/\/\* @detype: empty-line=([0-9]+) \*\//g, (_match, p1) =>
`\n`.repeat(p1 - 2))
  )
}

async function removeTypesFromVueSfcScript(
  expressionCode: string,
  fileName: string,
  script: SFCScriptBlock,
  options: RemoveTypeOptions,
) {
  if (script === null || script.lang !== 'ts')
    return script.content

  script.content += `/* @detype: remove-after-this */${expressionCode}`

  let scriptCode = await removeTypes(script.content, `${fileName}.ts`, options)

  const removeAfterIndex = scriptCode.indexOf(
    '/* @detype: remove-after-this */',
  )

  if (removeAfterIndex >= 0)
    scriptCode = scriptCode.slice(0, removeAfterIndex)

  return scriptCode
}

export function processMagicComments(input: string): string {
  const REPLACE_COMMENT = '// @detype: replace\n'
  const WITH_COMMENT = '// @detype: with\n'
  const END_COMMENT = '// @detype: end\n'

  let start = input.indexOf(REPLACE_COMMENT)

  while (start >= 0) {
    const middle = input.indexOf(WITH_COMMENT, start)
    if (middle < 0)
      return input
    const middleEnd = middle + WITH_COMMENT.length

    const end = input.indexOf(END_COMMENT, middleEnd)
    if (end < 0)
      return input
    const endEnd = end + END_COMMENT.length

    const before = input.slice(0, start)
    const newText = input.slice(middleEnd, end).replaceAll(/^\s*\/\//gm, '')
    const after = input.slice(endEnd)

    input = before + newText + after

    start = input.indexOf(REPLACE_COMMENT, before.length + newText.length)
  }

  return input
}

/**
 * Removes magic comments without performing the TS to JS transform
 * @param code            Source coude
 * @param fileName        File name for the source
 * @param prettierOptions Options to pass to prettier
 */
export async function removeMagicComments(
  code: string,
  fileName: string,
  prettierOptions?: PrettierOptions | null,
): Promise<string> {
  const REPLACE_COMMENT = '// @detype: replace\n'
  const WITH_COMMENT = '// @detype: with\n'
  const END_COMMENT = '// @detype: end\n'

  let start = code.indexOf(REPLACE_COMMENT)
  let startEnd = start + REPLACE_COMMENT.length

  while (start >= 0) {
    const middle = code.indexOf(WITH_COMMENT, start)
    if (middle < 0)
      return code
    const middleEnd = middle + WITH_COMMENT.length

    const end = code.indexOf(END_COMMENT, middleEnd)
    if (end < 0)
      return code
    const endEnd = end + END_COMMENT.length

    const before = code.slice(0, start)
    const keptText = code.slice(startEnd, middle)
    const after = code.slice(endEnd)

    code = before + keptText + after

    start = code.indexOf(REPLACE_COMMENT, before.length + keptText.length)
    startEnd = start + REPLACE_COMMENT.length
  }

  code = await format(code, {
    ...prettierOptions,
    filepath: fileName,
  })

  return code
}
