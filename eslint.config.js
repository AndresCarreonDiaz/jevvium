import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import wdio from 'eslint-plugin-wdio'

export default tseslint.config(
  { ignores: ['node_modules', 'reports', 'apps', 'runs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['generated/**'], ...wdio.configs['flat/recommended'] },
)
