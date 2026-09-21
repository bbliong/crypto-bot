param(
  [Parameter(Mandatory = $true)][int]$CollectorProcessId,
  [Parameter(Mandatory = $true)][string]$RunFolder
)

Set-Location 'C:\Projects\Crypto'
while (Get-Process -Id $CollectorProcessId -ErrorAction SilentlyContinue) {
  & 'C:\Program Files\nodejs\node.exe' 'scripts/generate-simulation-report.mjs' $RunFolder
  Start-Sleep -Seconds 5
}
& 'C:\Program Files\nodejs\node.exe' 'scripts/generate-simulation-report.mjs' $RunFolder
