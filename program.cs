ng Microsoft.AspNetCore.Components.Authorization;
using Microsoft.AspNetCore.Components.Server;
using Vision.Model.Trimble;
using Vision.Components;

var builder = WebApplication.CreateBuilder(args);

// ------------------------------------------------------------
// Razor Components / Blazor
// ------------------------------------------------------------

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();

// Detailed Blazor circuit errors
builder.Services.Configure<CircuitOptions>(options =>
{
    options.DetailedErrors = true;
});

builder.Services.AddServerSideBlazor()
    .AddHubOptions(options =>
    {
        options.MaximumReceiveMessageSize = 5 * 1024 * 1024;
    });

// ------------------------------------------------------------
// Radzen
// ------------------------------------------------------------

//builder.Services.AddRadzenComponents();

// ------------------------------------------------------------
// MVC / Controllers
// ------------------------------------------------------------

builder.Services.AddControllers();

// ------------------------------------------------------------
// HTTP
// ------------------------------------------------------------

builder.Services.AddHttpClient();

// ------------------------------------------------------------
// Services
// ------------------------------------------------------------

//builder.Services.AddSingleton<ToastService>();

//builder.Services.AddScoped<IAuthentication, Authentication>();

// ------------------------------------------------------------
// Authentication / Authorization
// ------------------------------------------------------------

builder.Services.AddAuthorizationCore();
builder.Services.AddCascadingAuthenticationState();

builder.Services.AddScoped<TrimbleTokenStore>();

builder.Services.AddScoped<TrimbleAuthenticationStateProvider>();

builder.Services.AddScoped<AuthenticationStateProvider>(
    services => services.GetRequiredService<TrimbleAuthenticationStateProvider>());

// ------------------------------------------------------------
// Session
// ------------------------------------------------------------

builder.Services.AddDistributedMemoryCache();

builder.Services.AddSession(options =>
{
    options.IdleTimeout = TimeSpan.FromMinutes(30);
    options.Cookie.Name = ".ParaMatic.Session";
    options.Cookie.HttpOnly = true;
    options.Cookie.IsEssential = true;
});

// Needed by services that access HttpContext
builder.Services.AddHttpContextAccessor();

// ------------------------------------------------------------
// CORS - Trimble Connect
// ------------------------------------------------------------

builder.Services.AddCors(options =>
{
    options.AddPolicy("TrimbleConnect", policy =>
    {
        policy
            .WithOrigins("https://web.connect.trimble.com")
            .AllowCredentials()
            .AllowAnyHeader()
            .AllowAnyMethod();
    });
});

// ------------------------------------------------------------
// Antiforgery
// ------------------------------------------------------------

builder.Services.AddAntiforgery(options =>
{
    options.Cookie.SameSite = SameSiteMode.None;
    options.Cookie.SecurePolicy = CookieSecurePolicy.Always;
});

// ------------------------------------------------------------
// Build application
// ------------------------------------------------------------

var app = builder.Build();

// ------------------------------------------------------------
// Error handling / HTTPS
// ------------------------------------------------------------

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler(
        "/Error",
        createScopeForErrors: true);

    app.UseHsts();
}


//app.Use(async (context, next) =>
//{
//    if (context.Request.Path.StartsWithSegments("/manifest.json"))
//    {
//        context.Response.Headers.Append("Access-Control-Allow-Origin", "https://web.connect.trimble.com");
//        context.Response.Headers.Append("Access-Control-Allow-Methods", "GET, OPTIONS");
//        context.Response.Headers.Append("Access-Control-Allow-Headers", "Content-Type");
//    }
//    await next();
//});

app.UseHttpsRedirection();

// ------------------------------------------------------------
// CORS
// IMPORTANT: before endpoints are executed
// ------------------------------------------------------------

app.UseCors("TrimbleConnect");

// ------------------------------------------------------------
// Session
// ------------------------------------------------------------

app.UseSession();

// ------------------------------------------------------------
// Static files
// This serves wwwroot/manifest.json and icon.png
// ------------------------------------------------------------

app.UseStaticFiles();

// ------------------------------------------------------------
// Routing
// ------------------------------------------------------------

app.UseRouting();

// ------------------------------------------------------------
// Antiforgery
// ------------------------------------------------------------

app.UseAntiforgery();

// ------------------------------------------------------------
// Status code handling
// ------------------------------------------------------------

app.UseStatusCodePagesWithReExecute(
    "/not-found",
    createScopeForStatusCodePages: true);

// ------------------------------------------------------------
// API Controllers
// ------------------------------------------------------------

app.MapControllers();

// ------------------------------------------------------------
// Blazor / Razor Components
// ------------------------------------------------------------

app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode(options =>
        options.ContentSecurityFrameAncestorsPolicy =
            "'self' https://web.connect.trimble.com");

// ------------------------------------------------------------
// Run
// ------------------------------------------------------------

app.Run();
