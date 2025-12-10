import express from "express";
import axios from "axios";
import fs from "fs";

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

// ===================== 持久化存储 =====================
const MAPPING_FILE = "./mapping.json";

// 内存映射
const customerToTopic = new Map();          // customerId -> topicId
const topicToCustomer = new Map();          // topicId -> customerId
const customerMsgToGroupMsg = new Map();    // customerMsgId -> groupMsgId
const groupMsgToCustomer = new Map();       // groupMsgId -> { customerId, customerMsgId }

// --- 从文件加载映射 ---
function loadMapping() {
  if (!fs.existsSync(MAPPING_FILE)) {
    console.log("📁 未找到 mapping.json，将创建新文件。");
    return;
  }

  try {
    const data = JSON.parse(fs.readFileSync(MAPPING_FILE, "utf8"));
    data.customerToTopic?.forEach(([k, v]) => customerToTopic.set(k, v));
    data.topicToCustomer?.forEach(([k, v]) => topicToCustomer.set(k, v));
    data.customerMsgToGroupMsg?.forEach(([k, v]) => customerMsgToGroupMsg.set(k, v));
    data.groupMsgToCustomer?.forEach(([k, v]) => groupMsgToCustomer.set(k, v));

    console.log("📥 映射已加载。");
  } catch (e) {
    console.error("❌ 映射文件读取失败：", e.message);
  }
}

// --- 保存映射到文件 ---
function saveMapping() {
  const data = {
    customerToTopic: [...customerToTopic],
    topicToCustomer: [...topicToCustomer],
    customerMsgToGroupMsg: [...customerMsgToGroupMsg],
    groupMsgToCustomer: [...groupMsgToCustomer],
  };

  fs.writeFileSync(MAPPING_FILE, JSON.stringify(data, null, 2));
  console.log("💾 映射已保存。");
}

loadMapping();

// ===================== 设置 Webhook =====================
async function setWebhook() {
  try {
    const res = await axios.get(`${API}/setWebhook`, {
      params: { url: WEBHOOK_URL },
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

// ===================== 话题获取/创建 =====================
async function getOrCreateTopic(customer) {
  const customerId = customer.id;

  if (customerToTopic.has(customerId)) {
    return customerToTopic.get(customerId);
  }

  const title = `客户 ${customerId}`;
  console.log("🧵 创建话题：", title);

  const res = await axios.post(`${API}/createForumTopic`, {
    chat_id: GROUP_CHAT_ID,
    name: title,
  });

  const topicId = res.data?.result?.message_thread_id;
  if (!topicId) throw new Error("createForumTopic 未返回 topicId");

  customerToTopic.set(customerId, topicId);
  topicToCustomer.set(topicId, customerId);
  saveMapping();

  return topicId;
}

// ===================== Webhook =====================
app.post("/webhook", async (req, res) => {
  const update = req.body;
  const msg = update.message;
  if (!msg) return res.sendStatus(200);

  logMessage("收到消息：", msg);

  const chatType = msg.chat.type;

  // =============== 1. 客户私聊机器人 ===============
  if (chatType === "private") {
    const customer = msg.from;
    const customerId = customer.id;

    try {
      // 首次欢迎
      if (!customerToTopic.has(customerId)) {
        await axios.post(`${API}/sendMessage`, {
          chat_id: customerId,
          text: `Bonjour, je m'appelle Lia. Souhaiteriez-vous que je vous présente ce poste ?`,
        });
      }

      // 话题
      const topicId = await getOrCreateTopic(customer);

      // ----- 发到群 -----
      let content = msg.text || "[消息]";
      if (msg.photo) content = "[Imagen]";
      if (msg.document) content = "[Documento]";

      const sent = await axios.post(`${API}/sendMessage`, {
        chat_id: GROUP_CHAT_ID,
        message_thread_id: topicId,
        text: content,
      });

      const groupMsgId = sent.data.result.message_id;

      // **保存消息映射（用于引用）**
      customerMsgToGroupMsg.set(msg.message_id, groupMsgId);
      groupMsgToCustomer.set(groupMsgId, {
        customerId,
        customerMsgId: msg.message_id,
      });
      saveMapping();

      // 图片转发
      if (msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        await axios.post(`${API}/sendPhoto`, {
          chat_id: GROUP_CHAT_ID,
          message_thread_id: topicId,
          photo: fileId,
        });
      }
    } catch (e) {
      console.error("处理客户消息失败：", e.response?.data || e.message);
    }

    return res.sendStatus(200);
  }

  // =============== 2. 客服在群内回复 ===============
  if (chatType === "supergroup") {
    if (String(msg.chat.id) !== GROUP_CHAT_ID) return res.sendStatus(200);

    const topicId = msg.message_thread_id;
    if (!topicId) return res.sendStatus(200);

    if (msg.from.is_bot) return res.sendStatus(200);

    const customerId = topicToCustomer.get(topicId);
    if (!customerId) return res.sendStatus(200);

    try {
      // ========== 判断客服是否对客户消息“回复” ==========
      if (msg.reply_to_message) {
        const repliedGroupMsgId = msg.reply_to_message.message_id;
        const mapping = groupMsgToCustomer.get(repliedGroupMsgId);

        if (mapping) {
          const { customerId, customerMsgId } = mapping;

          // ------ 带引用回复客户 ------
          await axios.post(`${API}/sendMessage`, {
            chat_id: customerId,
            text: msg.text,
            reply_to_message_id: customerMsgId, // 引用！
          });

          return res.sendStatus(200);
        }
      }

      // ========== 普通文本 (无引用) ==========
      if (msg.text) {
        await axios.post(`${API}/sendMessage`, {
          chat_id: customerId,
          text: msg.text,
        });
      }

      // ========== 图片 ==========
      if (msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        await axios.post(`${API}/sendPhoto`, {
          chat_id: customerId,
          photo: fileId,
          caption: msg.caption || "",
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
