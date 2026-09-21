param(
  [Parameter(Mandatory = $true)][int]$CollectorProcessId,
  [Parameter(Mandatory = $true)][string]$RunFolder
)

Wait-Process -Id $CollectorProcessId
Set-Location 'C:\Projects\Crypto'
& 'C:\Program Files\nodejs\node.exe' 'scripts/finalize-unclosed-paper.mjs' $RunFolder
& 'C:\Program Files\nodejs\node.exe' 'scripts/generate-simulation-report.mjs' $RunFolder
