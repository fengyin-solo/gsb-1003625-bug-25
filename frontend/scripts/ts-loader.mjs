// 极简 TS/别名 loader：只给冒烟脚本用，依赖 devDependencies 里的 typescript（纯 JS，跨平台）。
// 生产构建仍走 vite，不经过这里。
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

export async function resolve(specifier, context, nextResolve) {
  let target = specifier
  if (target.startsWith('@/')) {
    target = path.join(SRC, target.slice(2))
  }
  try {
    return await nextResolve(target, context)
  } catch (error) {
    if (!path.extname(target)) {
      return nextResolve(`${target}.ts`, context)
    }
    throw error
  }
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.ts')) {
    const source = await readFile(new URL(url), 'utf8')
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
      fileName: url,
    })
    return { format: 'module', source: outputText, shortCircuit: true }
  }
  return nextLoad(url, context)
}
