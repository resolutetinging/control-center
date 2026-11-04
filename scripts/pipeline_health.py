#!/usr/bin/env python3
"""各 dashboard 自動更新健康檢查：輸出 data/pipeline_health.json（公開於 Pages，只放中性文字）。

兩種檢查，任一異常就列：
  a. GitHub Actions API：workflow 最近一次成功執行是否在預期週期內；最近一次已結束的執行若失敗也列出。
  b. 資料新鮮度：讀 GitHub Pages 上的資料檔時間戳。

寬限設計（為何這樣設）：
  - Actions 的 schedule 常延遲數小時甚至更久（stock 實測延遲 8 小時），所以每日管線給 36 小時、
    週查證給 8 天（7 天加 1 天）、月查證給 34 天（31 天加 3 天）。
  - 月查證「首次排程前」不誤報：first_expected 之前若從未有成功紀錄，視為待首次執行、不列異常。
  - 台股：只有平日有資料、休市日無新資料，所以用「落後幾個交易日（平日）」判斷，容許落後 2 個平日。
  - 睡眠：沒有 Actions，由本機 Mac 推資料，只看資料檔最新一晚日期，容許落後 2 天。
"""
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone, date

OWNER = "resolutetinging"
TPE = timezone(timedelta(hours=8))
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "data", "pipeline_health.json")


def _max_date(vals):
    vals = [v for v in vals if isinstance(v, str) and len(v) >= 10]
    return max(v[:10] for v in vals) if vals else None


# 資料新鮮度讀取器：回傳 YYYY-MM-DD 或 None
def d_history(j):
    return _max_date([x.get("date") for x in j if isinstance(x, dict)])


def d_key(key):
    return lambda j: _max_date([j.get(key)])


def d_industry(j):
    return _max_date([i.get("last_checked") for i in j.get("industries", []) if isinstance(i, dict)])


def d_renewable_weekly(j):
    return _max_date([(j.get("weekly_check") or {}).get("last_checked")])


def d_stock(j):
    return _max_date([(v[-1] or {}).get("date") for v in j.values() if isinstance(v, list) and v])


def d_sleep(j):
    return _max_date(list((j.get("nights") or {}).keys()))


def pages(repo, path):
    return "https://%s.github.io/%s/%s" % (OWNER.lower(), repo, path)


# 每條管線：name、repo、workflow（None 表示無 Actions）、run_days（成功執行最大間隔）、
# every（顯示用預期週期）、first_expected（首次排程日，之前無成功紀錄不報）、
# data：(url, 讀取器, 最大落後天數 或 "weekday")
PIPELINES = [
    dict(name="AI Tracker 每日更新", repo="aitracker", workflow="daily-update.yml",
         run_days=1.5, every="每日",
         data=(pages("aitracker", "data/history.json"), d_history, 2)),
    dict(name="AI Tracker NVIDIA 週查證", repo="aitracker", workflow="weekly-nvidia-update.yml",
         run_days=8, every="每週",
         data=(pages("aitracker", "data/nv_status.json"), d_key("last_checked"), 9)),
    dict(name="AI Tracker 中美科技戰週查證", repo="aitracker", workflow="weekly-techwar-update.yml",
         run_days=8, every="每週",
         data=(pages("aitracker", "data/techwar_status.json"), d_key("last_checked"), 9)),
    dict(name="AI Tracker 產業導入月查證", repo="aitracker", workflow="monthly-industry-adoption-update.yml",
         run_days=34, every="每月",
         data=(pages("aitracker", "data/industry_adoption.json"), d_industry, 35)),
    dict(name="AI Tracker 全球指標月更", repo="aitracker", workflow="monthly-indicators-update.yml",
         run_days=34, every="每月", first_expected="2026-11-13",
         data=(pages("aitracker", "data/global_indicators.json"), d_key("updated"), 35)),
    dict(name="再生能源週查證", repo="renewable-tracker", workflow="weekly-renewable-update.yml",
         run_days=8, every="每週",
         data=(pages("renewable-tracker", "data/renewable_status.json"), d_renewable_weekly, 9)),
    dict(name="再生能源指標月更", repo="renewable-tracker", workflow="monthly-renewable-indicators.yml",
         run_days=34, every="每月", first_expected="2026-11-16",
         data=(pages("renewable-tracker", "data/renewable_indicators.json"), d_key("updated"), 35)),
    dict(name="台股每日更新", repo="stock-tracker", workflow="daily-stock-update.yml",
         run_days=4, every="每個平日",  # 4 天涵蓋週末與延遲
         data=(pages("stock-tracker", "data/stock_history.json"), d_stock, "weekday")),
    dict(name="台股盤中更新", repo="stock-tracker", workflow="intraday-stock-update.yml",
         run_days=4, every="每個平日"),
    dict(name="睡眠 v3 資料", repo="sleep-dashboard", workflow=None, every="每日（本機推送）",
         data=(pages("sleep-dashboard", "sleep_v3_history.json"), d_sleep, 2)),
]


class CheckError(Exception):
    pass


def fetch_json(url, token=None):
    """取 JSON；失敗拋 CheckError（訊息只含狀態碼或錯誤類型，不含 token）。"""
    last = None
    for attempt in range(2):
        hdr = {"User-Agent": "cc-pipeline-health", "Accept": "application/json"}
        if token and attempt == 0 and "api.github.com" in url:
            hdr["Authorization"] = "Bearer " + token
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=hdr), timeout=30) as r:
                return json.loads(r.read().decode("utf-8"), strict=False)
        except urllib.error.HTTPError as e:
            last = "HTTP %s" % e.code
        except Exception as e:  # noqa: BLE001
            last = type(e).__name__
    raise CheckError(last or "未知錯誤")


def parse_ts(s):
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def weekday_lag(latest, now):
    """latest 距「應有最新交易日」落後幾個平日（盤後 19:00 前不要求當天）。"""
    t = now.astimezone(TPE)
    exp = t.date()
    if t.hour < 19:
        exp -= timedelta(days=1)
    while exp.weekday() >= 5:
        exp -= timedelta(days=1)
    lat = date.fromisoformat(latest)
    n, d = 0, lat
    while d < exp:
        d += timedelta(days=1)
        if d.weekday() < 5:
            n += 1
    return n


def check_pipeline(p, now, token):
    items = []
    name = p["name"]
    wf = p.get("workflow")
    wf_url = "https://github.com/%s/%s/actions/workflows/%s" % (OWNER, p["repo"], wf) if wf else ""
    if wf:
        base = "https://api.github.com/repos/%s/%s/actions/workflows/%s/runs" % (OWNER, p["repo"], wf)
        try:
            ok_runs = fetch_json(base + "?status=success&per_page=1", token).get("workflow_runs", [])
            done = fetch_json(base + "?status=completed&per_page=1", token).get("workflow_runs", [])
        except CheckError as e:
            items.append(dict(name="無法檢查：" + name, status="failed",
                              detail="GitHub API 失敗（%s）" % e, href=wf_url))
            ok_runs, done = None, None
        if ok_runs is not None:
            if done and done[0].get("conclusion") in ("failure", "timed_out", "startup_failure"):
                items.append(dict(name=name, status="failed", detail="最近一次執行失敗",
                                  href=done[0].get("html_url") or wf_url))
            if ok_runs:
                age = (now - parse_ts(ok_runs[0]["created_at"])).total_seconds() / 86400
                if age > p["run_days"]:
                    items.append(dict(name=name, status="stale", href=wf_url,
                                      detail="最近成功 %d 天前，預期%s" % (int(age), p["every"])))
            else:
                fe = p.get("first_expected")
                if not fe or now.astimezone(TPE).date() >= date.fromisoformat(fe):
                    items.append(dict(name=name, status="stale", href=wf_url,
                                      detail="從未有成功執行紀錄，預期%s" % p["every"]))
    dp = p.get("data")
    if dp:
        url, reader, limit = dp
        href = wf_url or "https://github.com/%s/%s" % (OWNER, p["repo"])
        try:
            latest = reader(fetch_json(url))
        except CheckError as e:
            items.append(dict(name="無法檢查：%s 資料檔" % name, status="failed",
                              detail="讀取資料檔失敗（%s）" % e, href=href))
            return items
        except Exception:  # noqa: BLE001  資料格式變動
            latest = None
        if not latest:
            items.append(dict(name="無法檢查：%s 資料檔" % name, status="failed",
                              detail="資料檔讀不到時間戳", href=href))
            return items
        if limit == "weekday":
            lag = weekday_lag(latest, now)
            if lag > 2:
                items.append(dict(name=name, status="stale", href=href,
                                  detail="資料最新交易日 %s，落後 %d 個交易日" % (latest, lag)))
        else:
            days = (now.astimezone(TPE).date() - date.fromisoformat(latest)).days
            if days > limit:
                items.append(dict(name=name, status="stale", href=href,
                                  detail="資料最後更新 %s（%d 天前），預期%s" % (latest, days, p["every"])))
    return items


def run(now=None, token=None, pipelines=None):
    now = now or datetime.now(timezone.utc)
    items, ok = [], []
    for p in pipelines or PIPELINES:
        got = check_pipeline(p, now, token)
        if got:
            items.extend(got)
        else:
            ok.append(p["name"])
    return {"checked_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "items": items, "ok": ok}


def main():
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or None
    res = run(token=token)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("異常 %d 項、正常 %d 條" % (len(res["items"]), len(res["ok"])))
    for it in res["items"]:
        print(" -", it["status"], it["name"], "|", it["detail"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
