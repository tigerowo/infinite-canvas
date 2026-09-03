import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

export default defineConfig([
    ...nextVitals,
    ...nextTs,
    prettier,
    {
        rules: {
            "@typescript-eslint/no-explicit-any": "warn",
            "react-hooks/immutability": "off",
            "react-hooks/preserve-manual-memoization": "off",
            "react-hooks/purity": "off",
            "react-hooks/refs": "off",
            "react-hooks/set-state-in-effect": "off",
            "react-hooks/use-memo": "off",
        },
    },
    globalIgnores([".next/**", "out/**", "build/**", "coverage/**", "public/**", "next-env.d.ts"]),
]);
