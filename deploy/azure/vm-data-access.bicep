targetScope = 'resourceGroup'

@description('Current system-assigned VM identity, resolved by the parent deployment before this module starts.')
param principalId string
param keyVaultName string
param storageAccountName string
param backupContainerName string

var secretsUserRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
var blobContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}
resource backups 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: backups
  name: 'default'
}
resource backupContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = {
  parent: blobService
  name: backupContainerName
}

// Role assignment principalId is immutable. A recreated identity needs a new
// name even when its VM and the protected resources keep the same resource IDs.
resource vaultReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, principalId, secretsUserRoleId)
  scope: vault
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: secretsUserRoleId
  }
}
resource backupWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(backupContainer.id, principalId, blobContributorRoleId)
  scope: backupContainer
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: blobContributorRoleId
  }
}
