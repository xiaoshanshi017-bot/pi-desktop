param(
    [Parameter(Mandatory = $true)][Uri]$Uri,
    [Parameter(Mandatory = $true)][string]$Destination
)

$ErrorActionPreference = 'Stop'
if ($Uri.Scheme -ne 'https' -or $Uri.UserInfo) { throw 'Runtime downloads require an HTTPS release URL.' }
Add-Type -AssemblyName System.Net.Http
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$piDownloadClient = [System.Net.Http.HttpClient]::new()
$piDownloadRequest = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $Uri)
$piDownloadRequest.Headers.UserAgent.ParseAdd('Pi-Desktop-runtime-build')
$piDownloadCancel = [System.Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(180))
$piDownloadResponse = $null
$piDownloadStream = $null
$piDownloadOutput = $null
try {
    $piDownloadResponse = $piDownloadClient.SendAsync($piDownloadRequest, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead, $piDownloadCancel.Token).GetAwaiter().GetResult()
    $null = $piDownloadResponse.EnsureSuccessStatusCode()
    $piDownloadStream = $piDownloadResponse.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $piDownloadOutput = [System.IO.FileStream]::new($Destination, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $null = $piDownloadStream.CopyToAsync($piDownloadOutput, 1048576, $piDownloadCancel.Token).GetAwaiter().GetResult()
} finally {
    if ($piDownloadOutput) { $piDownloadOutput.Dispose() }
    if ($piDownloadStream) { $piDownloadStream.Dispose() }
    if ($piDownloadResponse) { $piDownloadResponse.Dispose() }
    $piDownloadCancel.Dispose()
    $piDownloadRequest.Dispose()
    $piDownloadClient.Dispose()
}
