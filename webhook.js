const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs").promises;
const path = require("path");
const xlsx = require("xlsx");
const dotenv = require("dotenv");
const {default: PQueue} = require("p-queue");

// Создаем Express приложение
const app = express();
app.use(express.json());

// Загрузка переменных окружения
dotenv.config();

const { TELEGRAM_BOT_TOKEN, ADMIN_ID, APP_URL } = process.env;
const adminIds = ADMIN_ID.split(",").map((id) => parseInt(id.trim()));
const webhookUrl = `${APP_URL}/api/webhook`;

// Инициализация бота в режиме webhook (без polling)
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

const queue = new PQueue({ concurrency: 2, interval: 2000 });

// Временные пути для хранения данных (в Vercel это будет работать только в рамках запроса)
const outputDir = "/tmp/output";
const logDir = "/tmp/logs";
const logFilePath = path.join(logDir, "wb_parser.log");

// Создаем временные директории при необходимости
async function ensureDirsExist() {
  for (const dir of [outputDir, logDir]) {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      console.error(`Failed to create directory ${dir}: ${error.message}`);
    }
  }
}

// Services
class LogService {
  constructor() {
    this.logMessages = {};
  }

  async log(message, level = "info") {
    const timestamp = new Date().toISOString();
    const logEntry = `${timestamp} - ${level.toUpperCase()} - ${message}\n`;
    try {
      await fs.appendFile(logFilePath, logEntry, "utf-8");
    } catch (error) {
      console.error(`Failed to write to log file: ${error.message}`);
    }
    console.log(logEntry.trim());
  }

  async updateLogMessage(userId, logMessage) {
    await this.log(logMessage);
    if (!this.logMessages[userId]) {
      const message = await bot.sendMessage(
        userId,
        `📄 *Логи парсинга:*\n${logMessage}`,
        { parse_mode: "Markdown" }
      );
      this.logMessages[userId] = {
        messageId: message.message_id,
        text: [logMessage],
      };
    } else {
      const currentLogs = this.logMessages[userId].text;
      currentLogs.push(logMessage);
      const newText = `📄 *Логи парсинга:*\n${currentLogs.join("\n")}`;
      try {
        await bot.editMessageText(newText, {
          chat_id: userId,
          message_id: this.logMessages[userId].messageId,
          parse_mode: "Markdown",
        });
        this.logMessages[userId].text = currentLogs;
      } catch (error) {
        await this.log(
          `Failed to update log for user ${userId}: ${error.message}`,
          "error"
        );
      }
    }
  }

  async clearLogMessages(userId) {
    if (this.logMessages[userId]) delete this.logMessages[userId];
  }
}

class FileService {
  constructor(bot, logService) {
    this.bot = bot;
    this.logService = logService;
    this.DELETE_FILE_TIMEOUT = 15000; // 15 seconds
  }

  async saveToExcel(data, filename) {
    if (!data.length) {
      await this.logService.log("No data to save to Excel", "warning");
      return null;
    }
    const worksheet = xlsx.utils.json_to_sheet(data);
    const workbook = xlsx.utils.book_new();

    // Устанавливаем ширину столбцов
    worksheet["!cols"] = [
      { wch: 50 }, // Название
      { wch: 30 }, // Количество товара
      { wch: 30 }, // Частота товара
    ];

    xlsx.utils.book_append_sheet(workbook, worksheet, "data");
    const filePath = path.join(outputDir, `${filename}.xlsx`);

    // Ensure directory exists before writing
    await ensureDirsExist();

    await fs.writeFile(
      filePath,
      xlsx.write(workbook, { type: "buffer", bookType: "xlsx" })
    );
    await this.logService.log(`Saved Excel to ${filePath}`);
    return filePath;
  }

  async sendExcelToUser(filePath, filename, userId) {
    try {
      // Проверяем доступ к файлу
      await fs.access(filePath);

      const today = new Date().toLocaleDateString("ru-RU");
      const caption = `📊 *Анализ категории Wildberries* (${today})`;

      await this.bot.sendDocument(userId, filePath, {
        caption,
        parse_mode: "Markdown",
      });

      await this.logService.log(
        `Excel report sent to user ${userId}: ${filePath}`
      );

      // Установка таймера на удаление файла через 15 секунд
      setTimeout(async () => {
        try {
          await fs.unlink(filePath);
          await this.logService.log(`Temporary file deleted: ${filePath}`);
        } catch (error) {
          await this.logService.log(
            `Error deleting temporary file ${filePath}: ${error.message}`,
            "error"
          );
        }
      }, this.DELETE_FILE_TIMEOUT);
    } catch (error) {
      await this.bot.sendMessage(
        userId,
        `❌ Ошибка при отправке файла: ${error.message}`,
        { parse_mode: "Markdown" }
      );
      await this.logService.log(
        `Failed to send Excel to user ${userId}: ${error.message}`,
        "error"
      );
    }
  }
}

class EvirmaClient {
  constructor(fileService) {
    this.fileService = fileService;
    this.headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    this.TIMEOUT = 30000; // 30 секунд
  }

  async queryEvirmaApi(keywords) {
    const payload = { keywords, an: false };
    const MAX_RETRIES = 3; // Максимальное количество попыток
    let attempt = 0;

    while (attempt < MAX_RETRIES) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.TIMEOUT);

        const response = await axios.post(
          "https://evirma.ru/api/v1/keyword/list",
          payload,
          {
            headers: this.headers,
            signal: controller.signal,
            timeout: this.TIMEOUT,
          }
        );

        clearTimeout(timeoutId);

        const filteredData = {
          data: {
            keywords: Object.fromEntries(
              Object.entries(response.data.data?.keywords || {}).filter(
                ([, data]) => data.cluster !== null
              )
            ),
          },
        };
        return Object.keys(filteredData.data.keywords).length
          ? filteredData
          : null;
      } catch (error) {
        attempt++;
        if (attempt >= MAX_RETRIES) {
          const errorMessage = `Ошибка при запросе к Evirma API: ${error.message}`;
          await logService.log(errorMessage, "error");
          throw new Error(errorMessage);
        }
        await new Promise((resolve) => setTimeout(resolve, 2000)); // Задержка перед повторной попыткой
      }
    }
  }

  async parseEvirmaResponse(evirmaData) {
    const parsedData = [];
    if (!evirmaData?.data?.keywords) return parsedData;
    for (const [keyword, keywordData] of Object.entries(evirmaData.data.keywords)) {
      // Skip if cluster is null or counts are 0
      if (!keywordData.cluster || 
          !keywordData.cluster.product_count || 
          !keywordData.cluster.freq_syn?.monthly) {
        continue;
      }
      
      parsedData.push({
        Название: keyword,
        "Количество товара": keywordData.cluster.product_count,
        "Частота товара": keywordData.cluster.freq_syn.monthly,
      });
    }
    return parsedData;
  }
}

class WildberriesParser {
  constructor(fileService, evirmaClient, logService) {
    this.fileService = fileService;
    this.evirmaClient = evirmaClient;
    this.logService = logService;
    this.catalogData = null;
    this.results = [];
    this.headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    this.MAX_PAGES = 50;
    this.activeParsingUsers = new Set();
    this.RETRY_WAIT_TIME = 30000; // 30 секунд

    // Создаем очередь задач с ограничением на 2 параллельных запроса
  }

  async fetchWbCatalog() {
    try {
      const response = await axios.get(
        "https://static-basket-01.wbbasket.ru/vol0/data/main-menu-ru-ru-v3.json",
        { headers: this.headers }
      );

      return response.data;
    } catch (error) {
      await this.logService.log(
        `Error fetching WB catalog: ${error.message}`,
        "error"
      );
      throw error;
    }
  }

  async extractCategoryData(catalog) {
    const categories = [];

    const processNode = (node) => {
      if (Array.isArray(node)) {
        // Если node это массив, обрабатываем каждый элемент
        node.forEach((item) => processNode(item));
        return;
      }

      if (node && typeof node === "object") {
        // Проверяем наличие необходимых полей
        if ("name" in node && "url" in node) {
          categories.push({
            name: node.name,
            shard: node.shard || null,
            url: node.url,
            query: node.query || null,
          });
        }

        // Обрабатываем дочерние элементы
        if (node.childs && Array.isArray(node.childs)) {
          node.childs.forEach((child) => processNode(child));
        }
      }
    };

    // Если catalog это массив, обрабатываем каждый элемент
    if (Array.isArray(catalog)) {
      catalog.forEach((item) => processNode(item));
    } else {
      // Если catalog это объект, обрабатываем его напрямую
      processNode(catalog);
    }

    await this.logService.log(`Extracted ${categories.length} categories`);
    return categories;
  }

  async findCategoryByUrl(url) {
    try {
      if (!this.catalogData) {
        this.catalogData = await this.fetchWbCatalog();
      }

      // Разбираем URL на базовый путь и параметры
      const urlObj = new URL(url);
      const baseUrl = urlObj.pathname;
      const searchParams = urlObj.searchParams;

      // Получаем параметры фильтрации
      const filterParams = {
        priceU: searchParams.get("priceU") || null,
        xsubject: searchParams.get("xsubject") || null,
        fbrand: searchParams.get("fbrand") || null,
        fsupplier: searchParams.get("fsupplier") || null,
        sort: searchParams.get("sort") || "popular",
      };

      await this.logService.log(
        `Searching for category with URL: ${baseUrl}\nFilter params: ${JSON.stringify(
          filterParams
        )}`
      );

      const categories = await this.extractCategoryData(this.catalogData);
      await this.logService.log(`Total categories found: ${categories.length}`);

      const category = categories.find((cat) => {
        const normalizedCatUrl = cat.url.toLowerCase().replace(/\/+$/, "");
        const normalizedSearchUrl = baseUrl.toLowerCase().replace(/\/+$/, "");
        return normalizedCatUrl === normalizedSearchUrl;
      });

      if (category) {
        await this.logService.log(`Found category: ${category.name}`);

        // Добавляем параметры фильтрации к query параметрам категории
        let query = category.query || "";
        if (filterParams.priceU) query += `&priceU=${filterParams.priceU}`;
        if (filterParams.xsubject)
          query += `&xsubject=${filterParams.xsubject}`;
        if (filterParams.fbrand) query += `&fbrand=${filterParams.fbrand}`;
        if (filterParams.fsupplier)
          query += `&fsupplier=${filterParams.fsupplier}`;
        if (filterParams.sort) query += `&sort=${filterParams.sort}`;

        return {
          ...category,
          query: query,
        };
      }

      await this.logService.log("Category not found in catalog", "warning");
      return null;
    } catch (error) {
      await this.logService.log(
        `Error in findCategoryByUrl: ${error.message}`,
        "error"
      );
      throw error;
    }
  }

  async scrapeWbPage(page, category,userId) {
    const url = `https://catalog.wb.ru/catalog/${category.shard}/catalog?appType=1&curr=rub&dest=-1257786&locale=ru&page=${page}&sort=popular&spp=0&${category.query}`;
    this.logService.log(`URL : ${url}`);
    const MAX_RETRIES = 6;
    let attempt = 0;

    while (attempt < MAX_RETRIES) {
      try {
        const response = await axios.get(url, { headers: this.headers });
        const productsCount = response.data.data?.products?.length || 0;
        const logMessage = `Страница ${page}: получено ${productsCount} товаров`;
        await this.logService.log(url);
        await this.logService.log(logMessage);

        // Добавляем задержку между запросами
        if (page % 10 === 0) {
          await this.logService.log("Ждем 10 секунд после 10 запросов...");
          await new Promise((resolve) => setTimeout(resolve, 10000)); // 10 секунд
        } else {
          await new Promise((resolve) => setTimeout(resolve, 2000)); // 2 секунды
        }

        return { data: response.data, logMessage };
      } catch (error) {
        attempt++;
        if (error.response && error.response.status === 429) {
          const retryMessage = `ℹ️ Возникла ошибка с лимитом Wildberries, отправим через ${this.RETRY_WAIT_TIME / 1000} секунд.`;
          await this.logService.log(retryMessage, "warning");
          const botMessage = await bot.sendMessage(
            userId,
            retryMessage,
            {parse_mode : "markdown"}
          );
          await new Promise((resolve) => setTimeout(resolve, this.RETRY_WAIT_TIME));
          const updateMessage = `Отправляем запрос для получения данных для страницы ${page}, попытка: ${attempt}`;
          await bot.editMessageText(updateMessage, {
            chat_id: userId,
            message_id: botMessage.message_id,
            parse_mode: "markdown"
          });
          await this.logService.log(updateMessage);
          continue;
        }

        let errorMessage = `Ошибка при получении данных со страницы ${page}: ${error.message}`;
        if (error.response) {
          errorMessage += `\nСтатус: ${error.response.status}`;
          if (error.response.data) {
            errorMessage += `\nОтвет сервера: ${JSON.stringify(error.response.data)}`;
          }
        }
        await this.logService.log(errorMessage, "error");
        throw new Error(errorMessage);
      }
    }

    throw new Error(`Не удалось получить данные для страницы ${page} после ${MAX_RETRIES} попыток.`);
  }

  async scrapeWbPageWithQueue(page, category,userId) {
    return queue.add(() => this.scrapeWbPage(page, category,userId));
  }

  async processProducts(productsData) {
    return (productsData.data?.products || [])
      .filter((product) => "name" in product)
      .map((product) => product.name);
  }

  async parseCategory(url, userId) {
    // Проверяем, не идет ли уже парсинг для этого пользователя
    if (this.activeParsingUsers.has(userId)) {
      await this.logService.log(
        `Parsing already in progress for user ${userId}`
      );
      return false;
    }

    this.activeParsingUsers.add(userId);
    const startTime = Date.now();
    this.results = [];

    try {
      const category = await this.findCategoryByUrl(url);
      if (!category) {
        await this.logService.log(
          "Category not found. Check the URL.",
          "warning"
        );
        return false;
      }

      for (let page = 1; page <= this.MAX_PAGES; page++) {
        try {
          const { data, logMessage } = await this.scrapeWbPageWithQueue(page, category,userId);
          await this.logService.updateLogMessage(userId, logMessage);

          const products = await this.processProducts(data);
          if (!products.length) {
            await this.logService.log(
              `Page ${page}: no products found, stopping parsing.`
            );
            break;
          }

          let evirmaResponse;
          try {
            evirmaResponse = await this.evirmaClient.queryEvirmaApi(products);
            if (!evirmaResponse) break;
          } catch (error) {
            await bot.sendMessage(userId, `❌ ${error.message}`, {
              parse_mode: "Markdown",
            });
            break;
          }

          const pageResults = await this.evirmaClient.parseEvirmaResponse(
            evirmaResponse
          );
          this.results.push(...pageResults);
        } catch (error) {
          await bot.sendMessage(userId, `❌ ${error.message}`, {
            parse_mode: "Markdown",
          });
          break;
        }
      }

      if (!this.results || !this.results.length) {
        return await bot.sendMessage(
          userId,
          `📊 Найдены товары, но у всех частота поиска равна 0.\nВозможно, эти товары редко ищут или они новые в каталоге.`,
          { parse_mode: "Markdown" }
        );
      }

      if (this.results.length > 0) {
        const filename = `${category.name}_analysis_${Date.now()}`;
        const filePath = await this.fileService.saveToExcel(
          this.results,
          filename
        );
        if (filePath) {
          await this.fileService.sendExcelToUser(filePath, filename, userId);
        }
      } else {
        await bot.sendMessage(
          userId,
          "❌ Не найдено товаров в данной категории с указанными фильтрами.",
          { parse_mode: "Markdown" }
        );
      }

      return true;
    } catch (error) {
      await this.logService.log(`Parsing error: ${error.message}`, "error");
      return false;
    } finally {
      this.activeParsingUsers.delete(userId);
      const elapsedTime = (Date.now() - startTime) / 1000;
      await this.logService.log(
        `Total parsing time: ${elapsedTime.toFixed(2)} seconds`
      );
    }
  }
}

class BotHandlers {
  constructor(bot, parser, logService) {
    this.bot = bot;
    this.parser = parser;
    this.logService = logService;
    this.waitingForUrl = {};
  }

  registerHandlers() {
    // Все обработчики сообщений регистрируются на объекте бота
    // но фактически обрабатываются через webhook
  }

  getMainMenu(userId) {
    const keyboard = {
      reply_markup: {
        keyboard: [["Парсить"]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    };
    if (adminIds.includes(userId))
      keyboard.reply_markup.keyboard.push(["Список подписчиков"]);
    return keyboard;
  }

  getUrlInputMenu() {
    return {
      reply_markup: {
        keyboard: [["Отмена"]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    };
  }

  async start(msg) {
    const userId = msg.from.id;
    const welcomeText =
      "🛍️ *Wilberries Parser Frequency Bot*\n\nЭтот бот анализирует категории Wildberries и предоставляет статистику частоты поиска товаров.\n\nДоступные команды:\n/parse - Запросить анализ категории\n/list - Показать список админов (только для админов)";
    await bot.sendMessage(userId, welcomeText, {
      parse_mode: "Markdown",
      ...this.getMainMenu(userId),
    });
  }

  async listAdmins(msg) {
    const userId = msg.from.id;
    const adminsList = adminIds.map((id) => `- ${id}`).join("\n");
    await bot.sendMessage(userId, `📋 Список админов:\n${adminsList}`, {
      parse_mode: "Markdown",
      ...this.getMainMenu(userId),
    });
  }

  async manualParse(msg) {
    const userId = msg.from.id;
    this.waitingForUrl[userId] = "manual";
    await bot.sendMessage(
      userId,
      "🔗 Пожалуйста, отправьте URL категории Wildberries в формате:\nhttps://www.wildberries.ru/catalog/<category>/\nНапример: https://www.wildberries.ru/catalog/dom-i-dacha/vannaya/aksessuary",
      { parse_mode: "Markdown", ...this.getUrlInputMenu() }
    );
  }

  async handleText(msg) {
    const userId = msg.from.id;
    const text = msg.text.trim();
    console.log("Received message:", text);

    if (text === "Парсить") return await this.manualParse(msg);
    if (text === "Список подписчиков") return await this.listAdmins(msg);
    if (text === "Отмена") {
      console.log("Отмена парсинга пользователем:", userId);
      if (this.waitingForUrl[userId]) {
        delete this.waitingForUrl[userId];
        await bot.sendMessage(userId, "❌ Ввод URL отменён.", {
          parse_mode: "Markdown",
          ...this.getMainMenu(userId),
        });
      }
      return;
    }

    if (this.waitingForUrl[userId]) {
      if (this.parser.activeParsingUsers.has(userId)) {
        await bot.sendMessage(
          userId,
          "⏳ Парсинг уже выполняется. Пожалуйста, дождитесь завершения текущего процесса.",
          { parse_mode: "Markdown" }
        );
        return;
      }

      // Простая проверка на соответствие домену Wildberries
      if (!text.startsWith("https://www.wildberries.ru/catalog/")) {
        await bot.sendMessage(
          userId,
          '❌ Ошибка: Неверный URL. Ссылка должна быть с сайта www.wildberries.ru и начинаться с "https://www.wildberries.ru/catalog/"',
          { parse_mode: "Markdown", ...this.getUrlInputMenu() }
        );
        return;
      }

      await bot.sendMessage(userId, "🔄 Запускаю анализ категории...", {
        reply_markup: { remove_keyboard: true },
      });

      try {
        const success = await this.parser.parseCategory(text, userId);
        await this.logService.clearLogMessages(userId);
        delete this.waitingForUrl[userId];

        await bot.sendMessage(
          userId,
          success ? "✅ Парсинг завершён." : "❌ Ошибка: Категория не найдена.",
          { parse_mode: "Markdown", ...this.getMainMenu(userId) }
        );
      } catch (error) {
        await bot.sendMessage(
          userId,
          `❌ Ошибка при получении категории: ${error.message}`,
          { parse_mode: "Markdown", ...this.getMainMenu(userId) }
        );
        delete this.waitingForUrl[userId];
      }
    }
  }

  async handleUnauthorized(msg) {
    const userId = msg.from.id;
    await this.logService.log(
      `Unauthorized access attempt from user ${userId}`,
      "warning"
    );
    await bot.sendMessage(userId, "❌ У вас нет доступа к этому боту.", {
      parse_mode: "Markdown",
    });
  }

  // Метод для обработки входящих обновлений
  async processUpdate(update) {
    // Проверка на наличие
    if (update.message) {
      const msg = update.message;
      const text = msg.text;
      const userId = msg.from.id;

      // Проверка на авторизацию
      if (!adminIds.includes(userId)) {
        return await this.handleUnauthorized(msg);
      }

      // Обработка команд
      if (text === "/start") {
        await this.start(msg);
      } else if (text === "/list") {
        await this.listAdmins(msg);
      } else if (text === "/parse") {
        await this.manualParse(msg);
      } else {
        // Обработка текстовых сообщений
        await this.handleText(msg);
      }
    }
  }
}

// Initialize services
const logService = new LogService();
const fileService = new FileService(bot, logService);
const evirmaClient = new EvirmaClient(fileService);
const wildberriesParser = new WildberriesParser(
  fileService,
  evirmaClient,
  logService
);
const botHandlers = new BotHandlers(bot, wildberriesParser, logService);

// Инициализация директорий при старте
ensureDirsExist();

// API routes для Vercel
// Health check эндпоинт
app.get("/api/health", async (req, res) => {
  res.status(200).send("Bot is running");
});

// Webhook эндпоинт
app.post("/api/webhook", async (req, res) => {
  try {
    const update = req.body;
    if (update.message) {
      const userId = update.message.from.id;

      // Проверяем, не идет ли уже парсинг для этого пользователя
      if (wildberriesParser.activeParsingUsers.has(userId)) {
        await bot.sendMessage(
          userId,
          "⏳ Выполняется парсинг. Пожалуйста, дождитесь его завершения.",
          { parse_mode: "Markdown" }
        );
        res.status(200).send("OK");
        return;
      }
    }

    await logService.log("Received webhook update");
    await botHandlers.processUpdate(req.body);
    res.status(200).send("OK");
  } catch (error) {
    await logService.log(`Webhook error: ${error.message}`, "error");
    res.status(500).send("Internal Server Error");
  }
});

// Эндпоинт для установки вебхука
app.get("/api/setup", async (req, res) => {
  const secretToken = req.query.token;
  if (secretToken !== process.env.SETUP_SECRET) {
    return res.status(403).send("Unauthorized");
  }

  try {
    // Удаляем старый вебхук, если он был
    await bot.deleteWebHook();
    // Устанавливаем новый вебхук
    await bot.setWebHook(webhookUrl);

    // Отправляем уведомление админам
    for (const adminId of adminIds) {
      try {
        await bot.sendMessage(
          adminId,
          "🤖 *Бот запущен и готов к работе!*\nВаш ID: " +
            adminId +
            "\nИспользуйте /start для начала работы.",
          { parse_mode: "Markdown" }
        );
      } catch (error) {
        await logService.log(
          `Failed to notify admin ${adminId}: ${error.message}`,
          "error"
        );
      }
    }

    res.status(200).send("Webhook setup successful!");
  } catch (error) {
    await logService.log(`Setup webhook error: ${error.message}`, "error");
    res.status(500).send(`Error setting up webhook: ${error.message}`);
  }
});

// Для локальной разработки
if (process.env.NODE_ENV === "development") {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, async () => {
    await logService.log(`Bot starting up on port ${PORT}...`);
    await logService.log(`Webhook URL: ${webhookUrl}`);
  });
}

// Экспортируем приложение для Vercel
module.exports = app;
