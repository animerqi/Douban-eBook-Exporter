// 后台 Service Worker：负责下载抓取结果
// （内容脚本无权调用 chrome.downloads，必须由扩展页面/Worker 发起）
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message && message.action === "download") {
    const html = message.html || "";
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download(
      {
        url: url,
        filename: message.filename || "content.html",
        saveAs: false,
      },
      function () {
        URL.revokeObjectURL(url);
      }
    );
  }
  return false;
});
