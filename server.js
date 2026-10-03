if (typeof File === 'undefined') {
  global.File = class File extends Blob {};
}

const express = require("express");
const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;

const BASE_URL = "https://nataeji.moe.gov.ye";
const SEARCH_URL = `${BASE_URL}/seat-numbers/secondary/`;
const PROCESS_URL = `${BASE_URL}/seat-numbers/secondary/process/`;

const REAL_BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "ar,en-US;q=0.9,en;q=0.8",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache"
};

app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));
app.use(express.static("public"));

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function looksLikeFourPartName(name) {
  const parts = cleanText(name).split(" ").filter(Boolean);
  return parts.length >= 4;
}

function extractCsrf(html) {
  const $ = cheerio.load(html);
  return $('input[name="csrfmiddlewaretoken"]').attr("value") || null;
}

function absoluteUrl(url) {
  if (!url) return null;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return new URL(url, BASE_URL).toString();
}

function createHttpClient(jar) {
  const config = {
    jar,
    withCredentials: true,
    timeout: 35000,
    maxRedirects: 5,
    headers: REAL_BROWSER_HEADERS
  };

  const proxyUrl = process.env.FIXIE_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (proxyUrl) {
    try {
      const { HttpsProxyAgent } = require("https-proxy-agent");
      config.httpsAgent = new HttpsProxyAgent(proxyUrl);
    } catch (e) {
      console.warn("https-proxy-agent is not installed, proxy ignored.");
    }
  }

  return wrapper(axios.create(config));
}

async function getResultHtml(resultUrl, jar) {
  const client = createHttpClient(jar);
  const response = await client.get(resultUrl, { headers: { "Referer": SEARCH_URL } });
  return response.data;
}

function parseResult(html) {
  const $ = cheerio.load(html);
  const bodyText = cleanText($("body").text());

  if (/انتهت صلاحية النتائج|صلاحية النتائج/i.test(bodyText)) {
    return { success: false, code: "EXPIRED", message: "انتهت صلاحية نتيجة البحث، يرجى إجراء الاستعلام مرة أخرى." };
  }

  let seatNumber = null, psn = null, academicYear = null, studentName = null;

  const seatMatch = bodyText.match(/رقم\s*الجلوس\s*[:：\-]?\s*([0-9٠-٩]+)/i);
  const psnMatch = bodyText.match(/PSN\s*[:：\-]?\s*([0-9٠-٩]+)/i);
  const yearMatch = bodyText.match(/العام\s*الدراسي\s*[:：\-]?\s*([0-9]{4}\s*\/\s*[0-9]{4})/i);
  const nameMatch = bodyText.match(/الاسم\s*[:：\-]?\s*(.+?)(?=\s+(?:رقم\s*الجلوس|العام\s*الدراسي|PSN)|$)/i);

  if (seatMatch) seatNumber = seatMatch[1];
  if (psnMatch) psn = psnMatch[1];
  if (yearMatch) academicYear = cleanText(yearMatch[1]);
  if (nameMatch) studentName = cleanText(nameMatch[1]);

  $("tr").each((_, row) => {
    const cells = $(row).find("th, td").map((__, el) => cleanText($(el).text())).get();
    if (cells.length < 2) return;
    if (!seatNumber && /رقم\s*الجلوس/i.test(cells[0])) seatNumber = cells[1];
    if (!psn && /PSN/i.test(cells[0])) psn = cells[1];
    if (!academicYear && /العام\s*الدراسي/i.test(cells[0])) academicYear = cells[1];
    if (!studentName && /^الاسم$/i.test(cells[0])) studentName = cells[1];
  });

  if (!seatNumber) {
    if (/لا توجد|لم يتم العثور|غير موجود/i.test(bodyText)) {
      return { success: false, code: "NOT_FOUND", message: "لم يتم العثور على بيانات بهذا الاسم." };
    }
    return { success: false, code: "UNEXPECTED_RESPONSE", message: "وصلت استجابة غير متوقعة من الموقع الرسمي. حاول لاحقًا." };
  }

  return { success: true, seat_number: seatNumber, psn, academic_year: academicYear, student_name: studentName };
}

app.post("/api/search", async (req, res) => {
  const academicYear = cleanText(req.body?.academic_year);
  const studentName = cleanText(req.body?.student_name);

  if (!academicYear || !studentName) {
    return res.status(400).json({ success: false, message: "جميع الحقول مطلوبة." });
  }

  if (!looksLikeFourPartName(studentName)) {
    return res.status(400).json({ success: false, message: "يرجى إدخال الاسم الرباعي كاملًا." });
  }

  const jar = new CookieJar();

  try {
    const client = createHttpClient(jar);
    const pageResponse = await client.get(SEARCH_URL, { headers: { "Referer": BASE_URL } });
    const csrfToken = extractCsrf(pageResponse.data);

    if (!csrfToken) {
      return res.status(502).json({ success: false, message: "تعذر الحصول على رمز الحماية من الموقع الرسمي." });
    }

    const processResponse = await client.post(
      PROCESS_URL,
      new URLSearchParams({ academic_year: academicYear, student_name: studentName, csrfmiddlewaretoken: csrfToken }).toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-CSRFToken": csrfToken,
          "X-Requested-With": "XMLHttpRequest",
          "Referer": SEARCH_URL,
          "Origin": BASE_URL
        },
        validateStatus: status => status >= 200 && status < 500
      }
    );

    const data = processResponse.data;
    if (!data || data.success !== true || !data.redirect_url) {
      return res.status(404).json({ success: false, message: data?.message || "لم يتم العثور على بيانات." });
    }

    const resultUrl = absoluteUrl(data.redirect_url);
    const resultHtml = await getResultHtml(resultUrl, jar);
    const result = parseResult(resultHtml);

    return res.json(result);
  } catch (error) {
    return res.status(504).json({ success: false, message: "استغرق الاتصال بالموقع الرسمي وقتًا طويلًا. حاول مرة أخرى." });
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/*splat", (_req, res) => {
  res.sendFile(require("path").join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => console.log(`Seat Number Search running on port ${PORT}`));
