#!/usr/bin/env python3
"""把夜雨飘零博客那篇心印介绍文整理成单栏 PDF 存档。

内容来源：https://blog.yeyupiaoling.cn/article/1793211366662（抓取于 2026-11-03）。
只做排版整理，不改正文表述；页脚标注原文链接与存档说明。
"""
from pathlib import Path

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

BASE = Path(__file__).resolve().parent
OUT_DOCX = BASE / "docs" / "心印插件介绍-夜雨飘零-2026-10-29.docx"

CN_FONT = "微软雅黑"
EN_FONT = "Segoe UI"
MONO_FONT = "Consolas"
GRAY = RGBColor(0x59, 0x59, 0x59)
DARK = RGBColor(0x1F, 0x1F, 0x1F)
ACCENT = RGBColor(0x1F, 0x4E, 0x79)


def set_run(run, *, name=CN_FONT, size=None, bold=None, color=None, mono=False):
    run.font.name = MONO_FONT if mono else EN_FONT
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.append(rfonts)
    rfonts.set(qn("w:eastAsia"), name)
    if size is not None:
        run.font.size = Pt(size)
    if bold is not None:
        run.bold = bold
    if color is not None:
        run.font.color.rgb = color


def add_page_field(paragraph):
    run = paragraph.add_run()
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = "PAGE"
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    run._r.append(begin)
    run._r.append(instr)
    run._r.append(end)


def build():
    doc = Document()
    section = doc.sections[0]
    section.page_width = Cm(21.0)
    section.page_height = Cm(29.7)
    section.top_margin = Cm(2.2)
    section.bottom_margin = Cm(2.2)
    section.left_margin = Cm(2.4)
    section.right_margin = Cm(2.4)

    normal = doc.styles["Normal"]
    normal.font.name = EN_FONT
    normal.font.size = Pt(10.5)
    normal.element.get_or_add_rPr()
    rpr = normal.element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.append(rfonts)
    rfonts.set(qn("w:eastAsia"), CN_FONT)
    normal.paragraph_format.line_spacing = 1.4
    normal.paragraph_format.space_after = Pt(5)

    for style_name, size in (("Heading 1", 16), ("Heading 2", 13), ("Heading 3", 11.5)):
        st = doc.styles[style_name]
        st.font.name = EN_FONT
        st.font.size = Pt(size)
        st.font.bold = True
        st.font.color.rgb = ACCENT
        rpr2 = st.element.get_or_add_rPr()
        rf = rpr2.find(qn("w:rFonts"))
        if rf is None:
            rf = OxmlElement("w:rFonts")
            rpr2.append(rf)
        rf.set(qn("w:eastAsia"), CN_FONT)

    footer = section.footer.paragraphs[0]
    footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = footer.add_run("心印插件介绍 · 夜雨飘零 · 存档版 · 第 ")
    set_run(run, size=8.5, color=GRAY)
    add_page_field(footer)
    run = footer.add_run(" 页")
    set_run(run, size=8.5, color=GRAY)

    # 标题区
    title = doc.add_paragraph()
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = title.add_run("心印（dsh-heartprint）：为 DSH 智能体加上会淡忘的性格与记忆")
    set_run(run, size=19, bold=True, color=ACCENT)

    meta = doc.add_paragraph()
    meta.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = meta.add_run("作者：夜雨飘零　·　发布于 2026-10-29　·　分类：DeepSeek Harness 插件")
    set_run(run, size=9.5, color=GRAY)

    link = doc.add_paragraph()
    link.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = link.add_run("原文：https://blog.yeyupiaoling.cn/article/1793211366662")
    set_run(run, size=9, color=GRAY)

    doc.add_paragraph()

    def h(text, level):
        doc.add_heading(text, level=level)

    def p(text):
        para = doc.add_paragraph()
        run = para.add_run(text)
        set_run(run, size=10.5, color=DARK)

    def bullets(items):
        for item in items:
            para = doc.add_paragraph(style="List Bullet")
            run = para.add_run(item)
            set_run(run, size=10.5, color=DARK)

    def table(rows):
        tbl = doc.add_table(rows=len(rows), cols=len(rows[0]))
        tbl.style = "Table Grid"
        tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
        for i, row in enumerate(rows):
            for j, cell_text in enumerate(row):
                cell = tbl.cell(i, j)
                cell.text = ""
                para = cell.paragraphs[0]
                para.paragraph_format.space_after = Pt(2)
                run = para.add_run(cell_text)
                set_run(run, size=9.5, color=DARK)
                if i == 0:
                    run.bold = True
                    shading = OxmlElement("w:shd")
                    shading.set(qn("w:fill"), "E7EEF7")
                    cell._tc.get_or_add_tcPr().append(shading)
        doc.add_paragraph()

    def code(text):
        for line in text.split("\n"):
            para = doc.add_paragraph()
            para.paragraph_format.left_indent = Cm(0.6)
            para.paragraph_format.space_after = Pt(1)
            run = para.add_run(line if line else " ")
            set_run(run, size=9, mono=True, color=DARK)

    h("前言", 1)
    p("在 DeepSeek Harness（DSH）里做长期陪伴或角色型助手时，常见做法是把整段聊天记录塞进上下文或外部数据库，模型要么「什么都记得」显得不像人，要么靠手工摘要维护成本高。心印（dsh-heartprint）走另一条路：在本机维护一套按时间分层、会压缩与淡忘的记忆库，长期保留性格形成、情感与重要事件节点，并定期整理成一份可交付的记忆文档。下面介绍它是什么、怎么装、日常怎么用，以及安装前需要留意的边界。")

    h("这是什么", 1)
    p("心印是维护者 youchen-yc 发布的 DSH 插件，社区目录分类为「趣味换装」，当前 GitHub 星标为 0。插件版本见仓库 package.json（资料中为 1.1.1），许可证 MIT，要求 Node >= 20、dsh >= 0.2.1-rc.1。")
    p("定位可以概括为：让 AI 拥有一套会自然淡忘的性格、情感与记忆——不是「数据库里存着全部聊天记录」，而是近事清晰、久远细节压缩、感受变淡，最终长期留下的是性格、情感与重要特殊事件的节点；值得保留的内容会整理成一份记忆文档，按节奏交到你指定的目录。")
    p("插件不联网、不上传；记忆落在本机数据目录（默认 <DSH_HOME>\\heartprint，未设置 DSH_HOME 时为 %USERPROFILE%\\.dsh\\heartprint）。")
    p("安全提示（资料原文）：1.1.0 之前的版本（1.0.0 / 1.0.1 / 1.0.2）未经过安全加固，存在已知加固缺失。请使用 1.1.0 及以上版本。")

    h("记忆如何分层与保留", 1)
    p("遗忘由可调的「遗忘日历」驱动，8 个层的 id 固定，默认起点如下（单位：天）：")
    table([
        ["id", "默认起点", "层含义"],
        ["fresh", "0", "近几天"],
        ["recent", "7", "清晰期尾声"],
        ["fade", "15", "半个月到一个月"],
        ["quarter", "30", "一个月到三个月"],
        ["halfyear", "90", "三个月到六个月"],
        ["year", "180", "六个月到一年"],
        ["longterm", "365", "一年到十年"],
        ["deep", "3650", "十年以上"],
    ])
    p("时间越久，正文与感受会按 README 中的表格逐步压缩、合并或删除琐碎内容；核心节点（性格形成、情感节点、灵性转折、重要特殊事件、痛苦记忆等）不参与合并与删除。记忆还按重要程度分四类：核心节点全量保留；重要（默认阈值 importantThreshold 70）、次重要（默认 secondaryThreshold 40）以压缩文本保留；琐碎才会走到合并与删除。")
    p("痛苦记忆单独处理：事实保留，当时的痛苦感受走强制淡忘轨道（7 天内完整，之后逐步变淡，1 年以上几乎只剩「发生过」），且不会回满到当时的痛。")
    p("离开对话超过 awayGraceDays（默认 7 天）再回来，这段期间不计入遗忘；不超过 7 天则照常维护。")

    h("核心能力概览", 1)
    bullets([
        "记与想：通过 heartprint 的 remember、recall、profile、status 写入记忆、按条件回想、读性格核心与统计。",
        "维护与交付：后台按插件启动、定时（约每 6 小时）、remember 后等时机自动维护（受 maintainThrottleMinutes 节流）；满 firstDeliveryAfterDays（默认 90 天）后自动交付第一份文档，之后每 deliveryIntervalDays（默认 30 天）一份；也可用 heartprint_admin action=deliver 立即交付。",
        "人设：首次安装空库时，AI 会在合适时机引导起名与人格、性格设定，写入 policy.json（每项最多 400 字）；之后可用 heartprint_admin action=policy 或「设置 → 心印」修改。",
        "管理：heartprint_admin 提供 maintain、doc、deliver、policy 等动作；遗忘日历、交付节奏、阈值等可通过 policy 的 patch 合并修改，reset: true 恢复默认。",
    ])
    p("交付文件命名示例：小印·陪伴3个月·2027-01-25.md，默认目录为工作区下的「心印交付」（可配置 deliveryDir）。交付后会持续更新同一份；你移动或删除该路径后，插件不会在原路径重建，到期会在交付目录生成新文件。每份文档是全量而非增量。")
    p("数据目录结构（资料原文）：")
    code("heartprint/\n ├─ memories.json              记忆库（唯一真相）\n ├─ policy.json                遗忘日历、交付节奏与人设\n └─ docs/                      内部工作区（自动维护）")

    h("安装与启用", 1)
    p("本插件是标准 DSH bundle。资料给出的分发安装方式为（需替换为插件文件夹的绝对路径）：")
    code("plugin_manager install_bundle   <插件文件夹绝对路径>")
    p("说明要点：")
    bullets([
        "只分发 package.json 的 files 清单内文件（如 index.js、client.js、lib/*.js、cordis.patch.yml 等），不要把 <DSH_HOME>\\heartprint 下的 memories.json、policy.json、docs/ 打包给别人。",
        "每个新安装默认空库；名字与人设不预置，由安装者自行设定。",
        "安装后工具出现在该 profile 的所有会话；可在 profile patch 或 cordis.patch.yml 中配置 dataDir、deliveryDir、personaName 等，也可在「设置 → 心印」修改。",
    ])
    p("安装前请自行阅读仓库源码与 LICENSE，并确认使用 1.1.0+ 版本。插件以当前 DSH 进程权限读写本机目录；记忆 JSON 在磁盘上可读，换机或清数据前请自行备份。")

    h("典型用法", 1)
    h("首次引导（由 AI 发起时）", 2)
    p("起名、人格、性格依次保存到 policy，例如：")
    code('heartprint_admin action=policy patch={"personaName":"名字"}\nheartprint_admin action=policy patch={"personaProfile":"…"}\nheartprint_admin action=policy patch={"characterProfile":"…"}\n\nheartprint action=status')
    h("记下一段记忆", 2)
    p("heartprint action=remember 可带 title、content、feeling、type、valence、importance、special、happenedAt、people、tags 等字段。type 可选包括 personality、emotion、turning_point、shared_beauty、pain、event、insight、daily；valence 可选 warm、tender、excited、calm、painful、mixed、neutral。")
    h("调整遗忘日历（示例）", 2)
    p("只写要改的层，afterDays 表示从哪一天起进入该层；插件会排序并保证严格递增：")
    code('{\n  "action": "policy",\n  "patch": {\n    "layers": [{ "id": "halfyear", "afterDays": 120 }],\n    "syncIntervalDays": 45\n  }\n}')
    h("工具速查", 2)
    table([
        ["工具", "action", "作用"],
        ["heartprint", "remember / recall / profile / status", "日常记、想、读档、看统计与交付节奏"],
        ["heartprint_admin", "maintain / doc / deliver / policy", "立即维护、读文档、交付、策略与人设"],
    ])
    p("heartprint_admin action=doc 可读 which=master / user / status；full=true 返回全文。")

    h("适用场景与注意", 1)
    p("适合：希望在 DSH 里做长期陪伴、角色一致性、情感节点可沉淀，又不想让上下文无限膨胀的开发者；需要本机可控、可导出 Markdown 记忆档案的场景。")
    p("注意：")
    bullets([
        "社区目录 SkillHub 插件页与 GitHub 仓库为社区分发与源码来源，与 DeepSeek / 幻方无官方从属关系；DSH 生态理念是「一切皆插件」。",
        "务必使用 1.1.0 及以上版本；安全细节见仓库 docs/security/、SECURITY.md，发布含 CycloneDX SBOM（sbom.cdx.json）。",
        "disclosure 配置项：confidential（默认）或 disclosed（已交付），按你的披露需求选择。",
    ])

    h("结尾", 1)
    p("心印把「像人一样会忘」做成可配置的引擎：分层压缩、核心节点长期保留、痛苦感受强制淡去，并把结果同步到一份可交付的记忆文档。若要在本机 DSH 环境试用，可从目录页了解分类与简介，从 GitHub 获取 bundle 并按 plugin_manager install_bundle 安装。")
    bullets([
        "目录页：https://www.skillhub.cn/plugins/youchen-yc/dsh-heartprint",
        "GitHub：https://github.com/youchen-yc/dsh-heartprint",
    ])

    doc.add_paragraph()
    note = doc.add_paragraph()
    run = note.add_run(
        "存档说明：本 PDF 由鲸進進于 2026-11-03 从原文页面整理排版，正文表述未改动；"
        "原文发布于 2026-10-29，文中版本号、许可证与星标数为当时抓取快照，可能与当前版本不一致。"
        "原文链接：https://blog.yeyupiaoling.cn/article/1793211366662"
    )
    set_run(run, size=8.5, color=GRAY)
    note.paragraph_format.space_before = Pt(12)

    OUT_DOCX.parent.mkdir(parents=True, exist_ok=True)
    doc.save(OUT_DOCX)
    print(f"WROTE {OUT_DOCX}")


if __name__ == "__main__":
    build()
