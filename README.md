# 课程笔记知识库 · 在线协作版

## 快速启动

cd course-notes-kb
npm install
node server.js

启动后访问 http://localhost:8686。

## 角色说明

| 角色 | 权限 |
|------|------|
| 管理员 | 上传/编辑笔记、添加批注、管理课程目录、修改设置 |
| 访客 | 浏览所有笔记和批注、在批注下回复/解答 |

## 技术栈

- 后端：Node.js + Express
- 前端：纯 HTML/CSS/JS（单页应用）
- 数据：JSON 内存存储，启动时从种子数据恢复
- 上传：支持 .html / .md 文件

