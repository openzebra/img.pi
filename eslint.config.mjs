import tseslint from "typescript-eslint";
import boundaries from "eslint-plugin-boundaries";

export default tseslint.config(
	{
		ignores: ["dist/**", "node_modules/**", "coverage/**", ".rlm/**"],
	},
	...tseslint.configs.strictTypeChecked,
	...tseslint.configs.stylisticTypeChecked,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.mjs"],
				},
				tsconfigRootDir: import.meta.dirname,
			},
		},
		plugins: {
			boundaries,
		},
		settings: {
			"boundaries/include": ["src/**/*.ts"],
			"boundaries/elements": [
				{ type: "core", pattern: "src/core/*" },
				{ type: "domain", pattern: "src/domain/*" },
				{ type: "config-schema", pattern: "src/config/schema.ts", mode: "full" },
				{ type: "host-port", pattern: "src/host/port.ts", mode: "full" },
				{ type: "workers-leaf", pattern: ["src/workers/protocol.ts", "src/workers/image.worker.ts"], mode: "full" },
				{ type: "workers-pool", pattern: "src/workers/pool.ts", mode: "full" },
				{
					type: "services",
					pattern: [
						"src/config/layers.ts",
						"src/config/store.ts",
						"src/config/migrate.ts",
						"src/jobs/*",
						"src/pipeline/*",
						"src/providers/*",
						"src/storage/*",
					],
					mode: "full",
				},
				{
					type: "app",
					pattern: ["src/wire.ts", "src/tools/*", "src/commands/*", "src/ui/**/*"],
					mode: "full",
				},
				{
					type: "host",
					pattern: [
						"src/index.ts",
						"src/host/detect.ts",
						"src/host/omp.ts",
						"src/host/pi.ts",
						"src/host/render-shim.ts",
						"src/host/ambient.d.ts",
					],
					mode: "full",
				},
			],
		},
		rules: {
			"@typescript-eslint/no-explicit-any": "error",
			"@typescript-eslint/no-non-null-assertion": "error",
			"@typescript-eslint/no-unsafe-argument": "error",
			"@typescript-eslint/no-unsafe-assignment": "error",
			"@typescript-eslint/no-unsafe-call": "error",
			"@typescript-eslint/no-unsafe-member-access": "error",
			"@typescript-eslint/no-unsafe-return": "error",
			"@typescript-eslint/switch-exhaustiveness-check": "error",
			"@typescript-eslint/prefer-readonly": "error",
			"@typescript-eslint/no-floating-promises": "error",
			"@typescript-eslint/no-misused-promises": "error",
			"@typescript-eslint/consistent-type-imports": [
				"error",
				{ prefer: "type-imports", fixStyle: "inline-type-imports" },
			],
			"@typescript-eslint/consistent-type-definitions": "off",
			"@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true, allowBoolean: true }],
			"@typescript-eslint/no-confusing-void-expression": ["error", { ignoreArrowShorthand: true }],
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
			"no-param-reassign": "error",
			"no-restricted-syntax": [
				"error",
				{
					selector: "TSNonNullExpression",
					message: "Non-null assertion (!) is forbidden by AGENTS.md §3.",
				},
				{
					selector:
						":matches(ForStatement, ForInStatement, ForOfStatement, WhileStatement, DoWhileStatement) AssignmentExpression[operator='+='][right.type='Literal']",
					message: "Never += strings inside loops (AGENTS.md §8). Collect into an array and .join('').",
				},
				{
					selector:
						":matches(ForStatement, ForInStatement, ForOfStatement, WhileStatement, DoWhileStatement) AssignmentExpression[operator='+='][right.type='TemplateLiteral']",
					message: "Never += strings inside loops (AGENTS.md §8). Collect into an array and .join('').",
				},
			],
			"boundaries/element-types": [
				"error",
				{
					default: "disallow",
					rules: [
						{ from: "core", allow: ["core"] },
						{ from: "domain", allow: ["domain", "core"] },
						{ from: "config-schema", allow: ["config-schema", "domain", "core"] },
						{ from: "host-port", allow: ["host-port", "config-schema", "domain", "core"] },
						{ from: "workers-leaf", allow: ["workers-leaf", "domain", "core"] },
						{ from: "workers-pool", allow: ["workers-pool", "workers-leaf", "domain", "core"] },
						{
							from: "services",
							allow: ["services", "workers-pool", "host-port", "config-schema", "domain", "core"],
						},
						{
							from: "app",
							allow: ["app", "services", "workers-pool", "host-port", "config-schema", "domain", "core"],
						},
						{
							from: "host",
							allow: ["host", "host-port", "app", "services", "workers-pool", "config-schema", "domain", "core"],
						},
					],
				},
			],
		},
	},
	{
		files: [
			"src/core/**/*.ts",
			"src/domain/**/*.ts",
			"src/config/**/*.ts",
			"src/services/**/*.ts",
			"src/jobs/**/*.ts",
			"src/pipeline/**/*.ts",
			"src/providers/**/*.ts",
			"src/storage/**/*.ts",
			"src/tools/**/*.ts",
			"src/commands/**/*.ts",
			"src/ui/**/*.ts",
			"src/workers/**/*.ts",
			"src/wire.ts",
		],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					patterns: [
						{
							group: ["@oh-my-pi/*", "@earendil-works/*"],
							message: "Only src/host/* and src/index.ts may import host packages (AGENTS.md §11).",
						},
					],
				},
			],
		},
	},
	{
		files: ["eslint.config.mjs"],
		extends: [tseslint.configs.disableTypeChecked],
	},
);
