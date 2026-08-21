// Generated from out/AssetRegistry.sol/AssetRegistry.json by scripts/extract-abis.mjs. Do not edit by hand.
// Source contract: AssetRegistry

export const assetRegistryAbi = [
  {
    "type": "function",
    "name": "assetAt",
    "inputs": [
      {
        "name": "i",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "assetCount",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "buildRequest",
    "inputs": [
      {
        "name": "assetId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "slot",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "evidence",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "commitEvidence",
    "inputs": [
      {
        "name": "assetId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "evidenceHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "uri",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "allowed",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "committee",
    "inputs": [
      {
        "name": "assetId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "string[]",
        "internalType": "string[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "committeeSize",
    "inputs": [
      {
        "name": "assetId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "config",
    "inputs": [
      {
        "name": "assetId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "c",
        "type": "tuple",
        "internalType": "struct AssetConfig",
        "components": [
          {
            "name": "issuer",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "quorum",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "minDistinctSigners",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "bandBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "minConfidenceBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "maxAgeSec",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "disputeBandBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "disputeBond",
            "type": "uint96",
            "internalType": "uint96"
          },
          {
            "name": "schemaId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "active",
            "type": "bool",
            "internalType": "bool"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "configureAsset",
    "inputs": [
      {
        "name": "assetId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "cfg",
        "type": "tuple",
        "internalType": "struct AssetConfig",
        "components": [
          {
            "name": "issuer",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "quorum",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "minDistinctSigners",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "bandBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "minConfidenceBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "maxAgeSec",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "disputeBandBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "disputeBond",
            "type": "uint96",
            "internalType": "uint96"
          },
          {
            "name": "schemaId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "active",
            "type": "bool",
            "internalType": "bool"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "evidenceAllowed",
    "inputs": [
      {
        "name": "assetId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "evidenceHash",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "metadataURI",
    "inputs": [
      {
        "name": "assetId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "string",
        "internalType": "string"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "modelAt",
    "inputs": [
      {
        "name": "assetId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "slot",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "string",
        "internalType": "string"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "registerAsset",
    "inputs": [
      {
        "name": "assetId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "cfg",
        "type": "tuple",
        "internalType": "struct AssetConfig",
        "components": [
          {
            "name": "issuer",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "quorum",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "minDistinctSigners",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "bandBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "minConfidenceBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "maxAgeSec",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "disputeBandBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "disputeBond",
            "type": "uint96",
            "internalType": "uint96"
          },
          {
            "name": "schemaId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "active",
            "type": "bool",
            "internalType": "bool"
          }
        ]
      },
      {
        "name": "models",
        "type": "string[]",
        "internalType": "string[]"
      },
      {
        "name": "uri",
        "type": "string",
        "internalType": "string"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "registerSchema",
    "inputs": [
      {
        "name": "head",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "mid",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "tail",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "schemaId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "schema",
    "inputs": [
      {
        "name": "schemaId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "s",
        "type": "tuple",
        "internalType": "struct AssetRegistry.PromptSchema",
        "components": [
          {
            "name": "head",
            "type": "bytes",
            "internalType": "bytes"
          },
          {
            "name": "mid",
            "type": "bytes",
            "internalType": "bytes"
          },
          {
            "name": "tail",
            "type": "bytes",
            "internalType": "bytes"
          },
          {
            "name": "exists",
            "type": "bool",
            "internalType": "bool"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "schemaIdOf",
    "inputs": [
      {
        "name": "head",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "mid",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "tail",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "setActive",
    "inputs": [
      {
        "name": "assetId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "active",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setCommittee",
    "inputs": [
      {
        "name": "assetId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "models",
        "type": "string[]",
        "internalType": "string[]"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "AssetActiveSet",
    "inputs": [
      {
        "name": "assetId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "active",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "AssetConfigured",
    "inputs": [
      {
        "name": "assetId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "config",
        "type": "tuple",
        "indexed": false,
        "internalType": "struct AssetConfig",
        "components": [
          {
            "name": "issuer",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "quorum",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "minDistinctSigners",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "bandBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "minConfidenceBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "maxAgeSec",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "disputeBandBps",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "disputeBond",
            "type": "uint96",
            "internalType": "uint96"
          },
          {
            "name": "schemaId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "active",
            "type": "bool",
            "internalType": "bool"
          }
        ]
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "AssetRegistered",
    "inputs": [
      {
        "name": "assetId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "issuer",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "schemaId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "CommitteeSet",
    "inputs": [
      {
        "name": "assetId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "models",
        "type": "string[]",
        "indexed": false,
        "internalType": "string[]"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "EvidenceCommitted",
    "inputs": [
      {
        "name": "assetId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "evidenceHash",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "uri",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      },
      {
        "name": "allowed",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "SchemaRegistered",
    "inputs": [
      {
        "name": "schemaId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "headLen",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "midLen",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "tailLen",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AssetExists",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadConfig",
    "inputs": []
  },
  {
    "type": "error",
    "name": "EmptyCommittee",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotIssuer",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SchemaExists",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnknownAsset",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnknownSchema",
    "inputs": []
  }
] as const;
