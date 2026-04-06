// Temporary endpoint to read the CS Weekly Performance Report structure
import { NextResponse } from "next/server";
import { google } from "googleapis";

function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT env var not set");
  const credentials = JSON.parse(raw);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const sheetId = url.searchParams.get("id") || "1BRvO8fCy8SEBphFW6hv_FXeS7uCOBWly";
    const tab = url.searchParams.get("tab") || "";

    const auth = getAuth();
    const sheets = google.sheets({ version: "v4", auth });

    // First get sheet metadata (tab names)
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: sheetId,
      fields: "sheets.properties",
    });

    const tabs = (meta.data.sheets || []).map((s) => ({
      title: s.properties?.title,
      sheetId: s.properties?.sheetId,
      rowCount: s.properties?.gridProperties?.rowCount,
      colCount: s.properties?.gridProperties?.columnCount,
    }));

    // If a specific tab is requested, read first 5 rows
    let sample = null;
    if (tab) {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `'${tab}'!A1:Z10`,
      });
      sample = res.data.values || [];
    }

    return NextResponse.json({ ok: true, tabs, sample });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
