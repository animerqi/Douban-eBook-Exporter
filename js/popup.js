document.addEventListener("DOMContentLoaded", function () {
  const startButton = document.getElementById("startButton");
  const stopButton = document.getElementById("stopButton");
  const status = document.getElementById("status");
  let pollTimer = null;

  function setStatus(text) {
    if (status) status.textContent = text;
  }

  function stopUi() {
    startButton.disabled = false;
    stopButton.disabled = true;
  }

  function runningUi() {
    startButton.disabled = true;
    stopButton.disabled = false;
  }

  function getActiveTab(callback) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (!tabs || !tabs[0]) {
        setStatus("未找到当前标签页");
        return;
      }
      callback(tabs[0]);
    });
  }

  // 如果内容脚本因 URL 不匹配等原因未注入，则手动注入（需要 scripting 权限）
  function ensureContentScript(tabId, callback) {
    chrome.tabs.sendMessage(tabId, { action: "ping" }, function (response) {
      if (chrome.runtime.lastError || !response || response.action !== "pong") {
        chrome.scripting.executeScript(
          { target: { tabId: tabId }, files: ["js/content.js"] },
          function () {
            if (chrome.runtime.lastError) {
              setStatus("脚本注入失败：" + chrome.runtime.lastError.message);
              stopUi();
              return;
            }
            callback();
          }
        );
      } else {
        callback();
      }
    });
  }

  // 向内容脚本查询真实抓取状态（弹窗每次打开都重新查询，不会误判）
  function queryStatus(tabId) {
    chrome.tabs.sendMessage(tabId, { action: "status" }, function (resp) {
      if (chrome.runtime.lastError || !resp || resp.action !== "status") {
        setStatus("未在抓取");
        stopUi();
        return;
      }
      if (resp.running) {
        runningUi();
        const extra = resp.transitioning ? "（正在切换章节…）" : "";
        let progressText;
        if (resp.mode === "paged") {
          progressText = "已抓 " + resp.count + " 段";
        } else if (resp.mode === "scroll") {
          progressText = "已滚动 " + resp.progress + "%";
        } else {
          progressText = "已抓 " + resp.count + " 段";
        }
        setStatus(
          "正在抓取…第 " + resp.chapter + " 章，" + progressText + extra
        );
      } else {
        stopUi();
        setStatus(resp.count > 0 ? "已停止（已抓 " + resp.count + " 段）" : "就绪");
      }
    });
  }

  // 打开弹窗：立即查询状态，并在弹窗打开期间每 2 秒刷新一次
  getActiveTab(function (tab) {
    if (!tab.url || !/^https:\/\/read\.douban\.com\/reader\//.test(tab.url)) {
      setStatus("请在豆瓣阅读的阅读页打开本扩展");
      return;
    }
    ensureContentScript(tab.id, function () {
      queryStatus(tab.id);
      pollTimer = setInterval(function () {
        queryStatus(tab.id);
      }, 2000);
    });
  });

  startButton.addEventListener("click", function () {
    getActiveTab(function (tab) {
      if (!tab.url || !/^https:\/\/read\.douban\.com\/reader\//.test(tab.url)) {
        setStatus("请先在豆瓣阅读的阅读页打开本扩展");
        return;
      }
      // 先查状态：正在抓取时禁止重复 start（防止误操作把进度重置）
      chrome.tabs.sendMessage(tab.id, { action: "status" }, function (resp) {
        if (!chrome.runtime.lastError && resp && resp.action === "status" && resp.running) {
          setStatus("已在抓取中…请勿重复开始");
          return;
        }
        ensureContentScript(tab.id, function () {
          runningUi();
          setStatus("正在抓取…请勿切换页面");
          chrome.tabs.sendMessage(tab.id, { action: "start" }, function (response) {
            if (chrome.runtime.lastError) {
              setStatus("启动失败：" + chrome.runtime.lastError.message);
              stopUi();
              return;
            }
            if (response && response.action === "error") {
              setStatus(response.message || "启动失败");
              stopUi();
            }
          });
        });
      });
    });
  });

  stopButton.addEventListener("click", function () {
    getActiveTab(function (tab) {
      chrome.tabs.sendMessage(tab.id, { action: "stop" }, function (response) {
        if (chrome.runtime.lastError) {
          setStatus("停止失败：" + chrome.runtime.lastError.message);
          stopUi();
          return;
        }
        if (response && response.action === "stopped") {
          setStatus("已停止，正在保存到下载目录…");
        }
        stopUi();
      });
    });
  });

  // 内容脚本发来的状态消息（弹窗开着时显示；关闭时不影响抓取和下载）
  chrome.runtime.onMessage.addListener(function (message) {
    if (message.action === "completed") {
      // 停止轮询，保留完成原因不被覆盖
      if (pollTimer) clearInterval(pollTimer);
      setStatus(message.text || "完成！已保存到下载目录");
      stopUi();
    } else if (message.action === "progress") {
      setStatus(message.text || "");
    }
  });
});
