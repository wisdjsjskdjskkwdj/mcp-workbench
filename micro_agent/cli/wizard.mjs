import readline from "node:readline";
import { C } from "../core/config.mjs";

/**
 * Interactive Schema Wizard for collecting tool arguments without manual JSON typing.
 */
export async function promptToolArguments(toolName, schema, rl) {
  const properties = schema?.properties || {};
  const requiredList = Array.isArray(schema?.required) ? schema.required : [];
  const propKeys = Object.keys(properties);

  if (propKeys.length === 0) {
    console.log(C.gray + `  (该工具不需要任何输入参数，直接执行)` + C.reset);
    return {};
  }

  console.log(C.cyan + C.bold + `\n🧙 进入 '${toolName}' 参数输入向导 (输入空行使用默认值或跳过可选参数):` + C.reset);

  const result = {};

  const ask = (promptText) => {
    return new Promise((resolve) => {
      rl.question(promptText, (ans) => {
        resolve(ans.trim());
      });
    });
  };

  for (const key of propKeys) {
    const prop = properties[key] || {};
    const isRequired = requiredList.includes(key);
    const reqTag = isRequired ? `${C.red}*(必填)${C.reset}` : `${C.gray}(选填)${C.reset}`;
    const typeTag = prop.type ? `[${prop.type}]` : "";
    const defaultTag = prop.default !== undefined ? `${C.yellow}[默认: ${JSON.stringify(prop.default)}]${C.reset}` : "";
    const desc = prop.description ? `${C.gray}- ${prop.description.split("\n")[0]}${C.reset}` : "";

    const promptLabel = `  👉 ${C.bold}${key}${C.reset} ${typeTag} ${reqTag} ${defaultTag} ${desc}\n     请输入 > `;

    while (true) {
      const input = await ask(promptLabel);

      if (!input) {
        if (prop.default !== undefined) {
          result[key] = prop.default;
          break;
        }
        if (isRequired) {
          console.log(C.red + `     ❌ 参数 '${key}' 为必填项，请输入有效值！` + C.reset);
          continue;
        }
        // Optional and empty, omit
        break;
      }

      // Convert value according to schema type
      try {
        if (prop.type === "number" || prop.type === "integer") {
          const num = Number(input);
          if (isNaN(num)) {
            console.log(C.red + `     ❌ 请输入合法的数字！` + C.reset);
            continue;
          }
          result[key] = num;
          break;
        } else if (prop.type === "boolean") {
          const lower = input.toLowerCase();
          result[key] = lower === "true" || lower === "1" || lower === "y" || lower === "yes";
          break;
        } else if (prop.type === "array" || prop.type === "object") {
          result[key] = JSON.parse(input);
          break;
        } else {
          result[key] = input;
          break;
        }
      } catch (err) {
        console.log(C.red + `     ❌ 输入解析失败 (${err.message})，请重新输入！` + C.reset);
      }
    }
  }

  console.log(C.gray + `\n  收集到的参数: ${JSON.stringify(result)}` + C.reset);
  return result;
}
