// netlify/functions/prices.js
// Server-side Tiingo proxy — no CORS issues, all tickers in one call
exports.handler = async function (event) {
  const TOKEN = "9be0e7ac6c2a6a337b292855cfc5b872c3fd8348";
  const tickers = (event.queryStringParameters && event.queryStringParameters.tickers) || "AAPL";

  try {
    const res = await fetch(`https://api.tiingo.com/iex?tickers=${tickers}&token=${TOKEN}`, {
      headers: {
        "Authorization": `Token ${TOKEN}`,
        "Content-Type": "application/json"
      }
    });
    const data = await res.text();
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=60"
      },
      body: data
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: e.message })
    };
  }
};
