const forecast = { error: true };
let days = null;
if (Array.isArray(forecast)) {
    days = forecast;
} else if (forecast.analysis && Array.isArray(forecast.analysis)) {
    days = forecast.analysis;
} else if (typeof forecast === "object") {
    for (const key of Object.keys(forecast)) {
        if (Array.isArray(forecast[key])) {
            days = forecast[key];
            break;
        }
    }
}
if (!days || days.length === 0) {
    console.log(
        "  ⚠️  Forecast structure unrecognized:",
        JSON.stringify(forecast).slice(0, 300),
    );
}
