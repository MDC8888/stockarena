exports.handler = async function(event) {
  const TOKEN = "9be0e7ac6c2a6a337b292855cfc5b872c3fd8348";
  const tickers = event.queryStringParameters?.tickers || "AAPL";
  try {
    const res = await fetch(`https://api.tiingo.com/iex?tickers=${tickers}&token=${TOKEN}`, {
      headers: { "Authorization": `Token ${TOKEN}`, "Content-Type": "application/json" }
    });
    const data = await res.json();
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(data)
    };
  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
