targetScope = 'resourceGroup'

@description('Short lowercase deployment prefix, 3-16 letters/digits/hyphens. Globally unique names also include the resource-group hash.')
@minLength(3)
@maxLength(16)
param namePrefix string = 'artoo'
param location string = resourceGroup().location
param adminUsername string = 'artooops'
@description('Operator SSH public key; never supply a private key.')
param sshPublicKey string
@description('Operator public IPv4 CIDR, normally x.x.x.x/32. Do not use 0.0.0.0/0. Also grants vault/storage firewall access.')
param adminSourceCidr string
@description('Initial small-team control server. Model execution remains on paired computers.')
param vmSize string = 'Standard_D2s_v5'
@minValue(64)
param dataDiskSizeGiB int = 128
@allowed(['Premium_LRS', 'StandardSSD_LRS'])
param dataDiskSku string = 'Premium_LRS'
@description('Pin an exact Canonical image version for repeat deployments after recording the initial resolved version.')
param ubuntuImageVersion string = 'latest'
param enableMonitoring bool = true
@description('Optional operations mailbox. Empty disables the CPU alert/action group; configure an owner before operational use.')
param alertEmail string = ''

var suffix = uniqueString(resourceGroup().id)
var storageName = 'artoo${suffix}'
var vaultName = 'artoo-${suffix}'
var serviceSubnetName = 'control'
var adminStorageIp = endsWith(adminSourceCidr, '/32') ? split(adminSourceCidr, '/')[0] : adminSourceCidr

resource nsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: '${namePrefix}-nsg'
  location: location
  properties: {
    securityRules: [
      {
        name: 'operator-ssh'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '22'
          sourceAddressPrefix: adminSourceCidr
          destinationAddressPrefix: '*'
        }
      }
      {
        name: 'public-https-and-acme'
        properties: {
          priority: 110
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRanges: ['80', '443']
          sourceAddressPrefix: 'Internet'
          destinationAddressPrefix: '*'
        }
      }
      {
        name: 'deny-other-inbound'
        properties: {
          priority: 4000
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourcePortRange: '*'
          destinationPortRange: '*'
          sourceAddressPrefix: '*'
          destinationAddressPrefix: '*'
        }
      }
    ]
  }
}
resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${namePrefix}-vnet'
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.46.0.0/16'] }
    subnets: [
      {
        name: serviceSubnetName
        properties: {
          addressPrefix: '10.46.1.0/24'
          networkSecurityGroup: { id: nsg.id }
          defaultOutboundAccess: false
          serviceEndpoints: [{ service: 'Microsoft.Storage' }, { service: 'Microsoft.KeyVault' }]
        }
      }
    ]
  }
}
var subnetId = resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, serviceSubnetName)
resource publicIp 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: '${namePrefix}-ip'
  location: location
  sku: { name: 'Standard' }
  properties: { publicIPAllocationMethod: 'Static' }
}
resource nic 'Microsoft.Network/networkInterfaces@2024-05-01' = {
  name: '${namePrefix}-nic'
  location: location
  properties: {
    ipConfigurations: [{ name: 'primary', properties: {
      privateIPAllocationMethod: 'Dynamic'
      subnet: { id: subnetId }
      publicIPAddress: { id: publicIp.id }
    } }]
  }
}
resource dataDisk 'Microsoft.Compute/disks@2024-03-02' = {
  name: '${namePrefix}-data'
  location: location
  sku: { name: dataDiskSku }
  properties: {
    creationData: { createOption: 'Empty' }
    diskSizeGB: dataDiskSizeGiB
    networkAccessPolicy: 'DenyAll'
    publicNetworkAccess: 'Disabled'
  }
}
resource vm 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: '${namePrefix}-control'
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    hardwareProfile: { vmSize: vmSize }
    securityProfile: {
      securityType: 'TrustedLaunch'
      uefiSettings: { secureBootEnabled: true, vTpmEnabled: true }
    }
    osProfile: {
      computerName: '${namePrefix}-control'
      adminUsername: adminUsername
      linuxConfiguration: {
        disablePasswordAuthentication: true
        provisionVMAgent: true
        ssh: { publicKeys: [{ path: '/home/${adminUsername}/.ssh/authorized_keys', keyData: sshPublicKey }] }
      }
    }
    storageProfile: {
      imageReference: { publisher: 'Canonical', offer: 'ubuntu-24_04-lts', sku: 'server', version: ubuntuImageVersion }
      osDisk: { createOption: 'FromImage', diskSizeGB: 64, managedDisk: { storageAccountType: 'StandardSSD_LRS' }, deleteOption: 'Detach' }
      dataDisks: [{ lun: 0, name: dataDisk.name, createOption: 'Attach', managedDisk: { id: dataDisk.id }, caching: 'None', deleteOption: 'Detach' }]
    }
    networkProfile: { networkInterfaces: [{ id: nic.id, properties: { primary: true, deleteOption: 'Detach' } }] }
    diagnosticsProfile: { bootDiagnostics: { enabled: true } }
  }
}
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: vaultName
  location: location
  properties: {
    tenantId: tenant().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    enablePurgeProtection: true
    softDeleteRetentionInDays: 90
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'None'
      ipRules: [{ value: adminSourceCidr }]
      virtualNetworkRules: [{ id: subnetId, ignoreMissingVnetServiceEndpoint: false }]
    }
  }
}
resource vaultReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, vm.id, 'secrets-user')
  scope: vault
  properties: {
    principalId: vm.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
  }
}
resource backups 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'None'
      ipRules: [{ action: 'Allow', value: adminStorageIp }]
      virtualNetworkRules: [{ id: subnetId, action: 'Allow' }]
    }
  }
}
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: backups
  name: 'default'
  properties: {
    isVersioningEnabled: true
    deleteRetentionPolicy: { enabled: true, days: 30 }
    containerDeleteRetentionPolicy: { enabled: true, days: 30 }
  }
}
resource backupContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'artoo-backups'
  properties: { publicAccess: 'None' }
}
resource backupWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: backupContainer
  name: guid(backupContainer.id, vm.id, 'backup-writer')
  properties: {
    principalId: vm.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  }
}
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = if (enableMonitoring) {
  name: '${namePrefix}-logs'
  location: location
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30, workspaceCapping: { dailyQuotaGb: 1 } }
}
resource monitorAgent 'Microsoft.Compute/virtualMachines/extensions@2024-07-01' = if (enableMonitoring) {
  parent: vm
  name: 'AzureMonitorLinuxAgent'
  location: location
  properties: { publisher: 'Microsoft.Azure.Monitor', type: 'AzureMonitorLinuxAgent', typeHandlerVersion: '1.0', autoUpgradeMinorVersion: true, enableAutomaticUpgrade: true }
}
resource collectionRule 'Microsoft.Insights/dataCollectionRules@2023-03-11' = if (enableMonitoring) {
  name: '${namePrefix}-syslog'
  location: location
  kind: 'Linux'
  properties: {
    dataSources: { syslog: [{ name: 'system-warnings', streams: ['Microsoft-Syslog'], facilityNames: ['auth', 'authpriv', 'daemon', 'syslog'], logLevels: ['Warning', 'Error', 'Critical', 'Alert', 'Emergency'] }] }
    destinations: { logAnalytics: [{ name: 'logs', workspaceResourceId: logs!.id }] }
    dataFlows: [{ streams: ['Microsoft-Syslog'], destinations: ['logs'] }]
  }
}
resource association 'Microsoft.Insights/dataCollectionRuleAssociations@2023-03-11' = if (enableMonitoring) {
  name: 'artoo-system-warnings'
  scope: vm
  properties: { dataCollectionRuleId: collectionRule!.id }
}
resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = if (enableMonitoring && alertEmail != '') {
  name: '${namePrefix}-operations'
  location: 'global'
  properties: { groupShortName: 'ArtooOps', enabled: true, emailReceivers: [{ name: 'operator', emailAddress: alertEmail, useCommonAlertSchema: true }] }
}
resource cpuAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = if (enableMonitoring && alertEmail != '') {
  name: '${namePrefix}-cpu'
  location: 'global'
  properties: {
    description: 'Control VM CPU > 80% for 15 minutes. This is not application or backup health.'
    severity: 2
    enabled: true
    scopes: [vm.id]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [{ name: 'high-cpu', criterionType: 'StaticThresholdCriterion', metricNamespace: 'Microsoft.Compute/virtualMachines', metricName: 'Percentage CPU', operator: 'GreaterThan', threshold: 80, timeAggregation: 'Average' }]
    }
    actions: [{ actionGroupId: actionGroup!.id }]
  }
}

output vmName string = vm.name
output publicIpAddress string = publicIp.properties.ipAddress
output dataDiskResourceId string = dataDisk.id
output managedIdentityPrincipalId string = vm.identity.principalId
output keyVaultName string = vault.name
output backupStorageAccount string = backups.name
output backupContainerName string = backupContainer.name
output logAnalyticsWorkspaceId string = enableMonitoring ? logs!.id : ''
