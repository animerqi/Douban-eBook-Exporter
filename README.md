# Douban-eBook-Exporter（增强版）

> 将豆瓣阅读（[read.douban.com](https://read.douban.com)）已购买的书籍导出为 HTML（可进一步用 Calibre 等软件转换为 EPUB）。

**⚠️ 本软件仅用于导出自己已购买的书籍，供个人离线阅读和收藏，请勿用于非法用途！作者不对滥用行为承担任何赔偿责任。**

---

## 📌 项目来源

本项目是 **[Violin9906/Douban-eBook-Exporter](https://github.com/Violin9906/Douban-eBook-Exporter)（v1.0）的增强版（Fork）**。

- **原作者**：Violin Wang（GitHub: [Violin9906](https://github.com/Violin9906)）
- **原始许可证**：MIT License，Copyright (c) 2023 Violin Wang（见 [LICENSE](LICENSE)）
- **本增强版**：在原版基础上修复了若干问题、增加了对两套豆瓣阅读界面的支持，详细改动见 [CHANGELOG.md](CHANGELOG.md)。

感谢原作者的开源贡献！本项目的所有改动同样以 MIT 许可证发布，并保留原版权声明。

---

## ✨ 与原版的区别

原版 v1.0 只支持**完结书籍（分页式阅读界面）**，且存在图片重复、图片缺失等问题。本增强版：

| 能力 | 原版 v1.0 | 本增强版 |
| --- | --- | --- |
| 完结书籍（`reader/ebook/*`，分页式） | ✅ | ✅（修复图片问题） |
| 未完结/专栏（`reader/column/*`，滚动式） | ❌ | ✅ |
| 自动检测界面类型 | ❌ | ✅（按 URL 判别） |
| 图片去重（同一张图只输出一次） | ❌ | ✅ |
| 图片内嵌（base64，离线可读） | ❌ | ✅ |
| 章节标题（从「下一篇」链接解析） | ❌ | ✅ |
| 后台运行 / 断点续抓 / 进度显示 | ❌ | ✅ |

---

## 🚀 使用方法

### 1. 安装（加载扩展）

1. 下载本项目并解压（或克隆）；
2. 打开 Chrome / Edge，地址栏输入 `chrome://extensions`（Edge 为 `edge://extensions`）；
3. 打开右上角**「开发者模式」**；
4. 点击**「加载已解压的扩展程序」**，选择本项目文件夹（含 `manifest.json`）；
5. 确认扩展图标出现在工具栏。

### 2. 导出书籍

1. 登录 [read.douban.com](https://read.douban.com)，打开**已购买**书籍的阅读页：
   - 完结书籍：`https://read.douban.com/reader/ebook/...`
   - 未完结/专栏：`https://read.douban.com/reader/column/.../chapter/...`
2. 定位到书籍/章节的正文第一页；
3. 点击工具栏扩展图标 → 点 **start**；
4. 扩展自动检测界面类型：
   - **完结书籍**：模拟 → 键逐页翻页，直到「全文完」；
   - **未完结/专栏**：抓取 DOM 中的全部页，逐章自动跳转；
5. 抓取完成后**自动保存 `content.html` 到下载目录**（没有弹窗提示是正常的）；
6. 中途想停止：打开扩展弹窗点 **stop**（同样会保存已抓内容）。

### 3. 后处理（可选）

```bash
pip install beautifulsoup4 requests
python parse.py content.html output.html
```

- 把 `headline-level-N` 样式转换为 `<hN>` 标题标签；
- 缓存图片到本地 `img/` 文件夹；
- 清理隐藏元素。

处理后的 HTML 可导入 [Calibre](https://calibre-ebook.com/) 等软件转换为 EPUB / PDF / MOBI 等格式。

### 4. 后台运行提示

- 抓取在页面内运行，**关闭弹窗不影响抓取**；
- 想查看进度：随时点开扩展图标，弹窗会显示当前章节与进度；
- 若切到其它标签页，Chrome 会限速后台标签，且隐藏页不加载懒加载图片——建议把豆瓣页面放在独立窗口保持活动，或回来后等它自动补图。

---

## 📂 项目结构

```
Douban-eBook-Exporter/
├── manifest.json      # 扩展清单（MV3）
├── js/content.js      # 核心抓取逻辑（双界面自动适配、去重、图片内嵌）
├── js/popup.js        # 弹出菜单（start/stop、状态同步）
├── js/background.js   # 后台 Service Worker（负责下载）
├── html/popup.html    # 弹出菜单界面
├── images/            # 扩展图标
├── parse.py           # 后处理脚本（标题转换、图片缓存、清理）
├── CHANGELOG.md       # 版本历史
└── LICENSE            # MIT License
```

---

## 📝 免责声明

本软件**仅用于导出购买者自己已购买的书籍**，供个人离线阅读与收藏。请尊重版权，**勿将导出内容用于任何商业或非法用途**。使用者需自行承担因滥用产生的法律责任，原作者与本项目作者不承担任何赔偿责任。
