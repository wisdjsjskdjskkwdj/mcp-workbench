import { C } from "../../core/config.mjs";
import { handleCall, handleInvoke } from "./cmd_call.mjs";
import { handleAddServer, handleRemoveServer } from "./cmd_servers.mjs";
import { handleScan } from "./cmd_clients.mjs";

export async function handleTest(client, toolsMap, suite = "all") {
  console.log(C.bold + C.magenta + `\n🧪 开始执行测试套件: [${suite}]` + C.reset);
  console.log("=".repeat(50));

  switch (suite) {
    case "math":
      console.log(C.cyan + "测试: 链式复合运算 (20 * 15) + 50" + C.reset);
      await handleCall(client, toolsMap, "math_ops__multiply", JSON.stringify({ a: 20, b: 15 }));
      await handleCall(client, toolsMap, "math_ops__add", JSON.stringify({ a: 300, b: 50 }));
      break;

    case "clock":
      console.log(C.cyan + "测试: 时钟感知查询 (Asia/Shanghai)" + C.reset);
      await handleCall(client, toolsMap, "sys_clock__get_time", JSON.stringify({ timezone: "Asia/Shanghai" }));
      break;

    case "cold":
      console.log(C.cyan + "测试: 冷工具检索与穿透调用 (fibonacci n=7)" + C.reset);
      await handleInvoke(client, "math_ops", "fibonacci", JSON.stringify({ n: 7 }));
      break;

    case "weather":
      console.log(C.cyan + "测试: 动态服务自举挂载与调用测试" + C.reset);
      await handleAddServer(client, ["weather_test", "node", "./dist/test_servers/mock_server_c.js"]);
      await handleCall(client, toolsMap, "weather_test__get_forecast", JSON.stringify({ city: "Shenzhen", days: 3 }));
      await handleRemoveServer(client, "weather_test");
      break;

    case "client":
      console.log(C.cyan + "测试: 客户端 5 层漏斗扫描" + C.reset);
      await handleScan(client);
      break;

    case "all":
    default:
      console.log(C.cyan + "[1/4] 测试数学运算工具 (10 + 25):" + C.reset);
      await handleCall(client, toolsMap, "math_ops__add", JSON.stringify({ a: 10, b: 25 }));

      console.log(C.cyan + "[2/4] 测试系统时钟工具 (Asia/Shanghai):" + C.reset);
      await handleCall(client, toolsMap, "sys_clock__get_time", JSON.stringify({ timezone: "Asia/Shanghai" }));

      console.log(C.cyan + "[3/4] 测试冷工具检索与直调 (fibonacci n=6):" + C.reset);
      await handleInvoke(client, "math_ops", "fibonacci", JSON.stringify({ n: 6 }));

      console.log(C.cyan + "[4/4] 测试动态服务自举挂载与卸载 (weather):" + C.reset);
      await handleAddServer(client, ["weather_test", "node", "./dist/test_servers/mock_server_c.js"]);
      await handleCall(client, toolsMap, "weather_test__get_forecast", JSON.stringify({ city: "Beijing", days: 3 }));
      await handleRemoveServer(client, "weather_test");
      break;
  }

  console.log(C.green + C.bold + "🎉 测试套件执行完毕！\n" + C.reset);
}
