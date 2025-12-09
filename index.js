import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// ===================== 配置 =====================
const TOKEN = process.env.BOT_TOKEN;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

console.log("🔧 BOT_TOKEN =", TOKEN);
console.log("🔧 GROUP_CHAT_ID =", GROUP_CHAT_ID);
console.log("🔧 WEBHOOK_URL =", WEBHOOK_URL);

const API = `https://api.telegram.org/bot${TOKEN}`;

// 内存映射
const customerToTopic = new Map(); // customerId -> topicId
const topicToCustomer = new Map(); // topicId -> customerId

// ===================== 设置 Webhook =====================
async function setWebhook() {
  try {
    const res = await axios.get(`${API}/setWebhook`, {
      params: { url: WEBHOOK_URL }
    });
    console.log("Webhook 已设置：", res.data);
  } catch (e) {
    console.error("Webhook 设置失败：", e.response?.data || e.message);
  }
}
setWebhook();

// ===================== 日志 =====================
function logMessage(prefix, msg) {
  console.log(
    `${prefix} chatId=${msg.chat.id} type=${msg.chat.type} ` +
      `thread=${msg.message_thread_id ?? "-"} from=${msg.from.id} ` +
      `text=${msg.text || "[非文本]"}`
  );
}

// ===================== 创建话题 =====================
async function getOrCreateTopic(customer) {
  const customerId = customer.id;

  if (customerToTopic.has(customerId)) {
    return customerToTopic.get(customerId);
  }

  const title = `客户 ${customerId}`;

  console.log("🧵 创建话题：", title);

  const res = await axios.post(`${API}/createForumTopic`, {
    chat_id: GROUP_CHAT_ID,
    name: title
  });

  const topicId = res.data?.result?.message_thread_id;
  if (!topicId) throw new Error("createForumTopic 未返回 message_thread_id");

  customerToTopic.set(customerId, topicId);
  topicToCustomer.set(topicId, customerId);

  return topicId;
}

// ===================== 主 Webhook =====================
app.post("/webhook", async (req, res) => {
  const update = req.body;
  const msg = update.message;
  if (!msg) return res.sendStatus(200);

  logMessage("收到消息：", msg);

  const chatType = msg.chat.type;

  // =============== 情况 1：客户私聊机器人 ===============
  if (chatType === "private") {
    const customer = msg.from;
    const customerId = customer.id;

    try {
      // 自动欢迎（只发一次）
      if (!customerToTopic.has(customerId)) {
        await axios.post(`${API}/sendMessage`, {
          chat_id: customerId,
          text: `Bonjour, je m'appelle Lia. Souhaiteriez-vous que je vous présente ce poste ?`
        });
      }

      // 获取 / 创建话题
      const topicId = await getOrCreateTopic(customer);

      // -------- 构建内容（无头部） --------
      let content = msg.text || "";
      if (!content) {
        if (msg.photo) content = "[Imagen]";
        else if (msg.document) content = "[Documento]";
        else content = "[Mensaje no textual]";
      }

      // ---- 把消息发到客服群对应话题（无客户信息前缀）----
      await axios.post(`${API}/sendMessage`, {
        chat_id: GROUP_CHAT_ID,
        message_thread_id: topicId,
        text: content
      });

      // 图片处理
      if (msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        await axios.post(`${API}/sendPhoto`, {
          chat_id: GROUP_CHAT_ID,
          message_thread_id: topicId,
          photo: fileId
        });
      }
    } catch (e) {
      console.error("处理客户消息失败：", e.response?.data || e.message);
    }

    return res.sendStatus(200);
  }

  // =============== 情况 2：客服在群内回复 ===============
  if (chatType === "supergroup") {
    if (String(msg.chat.id) !== GROUP_CHAT_ID) {
      return res.sendStatus(200);
    }

    const topicId = msg.message_thread_id;
    if (!topicId) return res.sendStatus(200);

    // 不处理机器人消息
    if (msg.from.is_bot) return res.sendStatus(200);

    const customerId = topicToCustomer.get(topicId);
    if (!customerId) {
      console.log("⚠️ 找不到对应客户 topicId =", topicId);
      return res.sendStatus(200);
    }

    try {
      // 图片
      if (msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        await axios.post(`${API}/sendPhoto`, {
          chat_id: customerId,
          photo: fileId,
          caption: msg.caption || ""
        });
        return res.sendStatus(200);
      }

      // 文本
      if (msg.text) {
        await axios.post(`${API}/sendMessage`, {
          chat_id: customerId,
          text: msg.text
        });
      }
    } catch (e) {
      console.error("客服回复失败：", e.response?.data || e.message);
    }

    return res.sendStatus(200);
  }

  return res.sendStatus(200);
});

// ===================== 启动服务器 =====================
app.listen(Number(process.env.PORT) || 3000, () => {
  console.log("🚀 Bot 已启动");
});
