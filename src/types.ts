export interface R2SQLConfig {
  accountId: string;
  bucketName: string;
  apiToken: string;
  warehouse: string;
  catalogEndpoint: string;
}

export interface R2SQLQueryResult {
  data: any[];
  metadata?: {
    rowCount?: number;
    executionTime?: number;
    bytesScanned?: number;
  };
  schema?: any;
  headers?: any;
  error?: string;
}

export interface IcebergNamespace {
  namespace: string[];
}

export interface IcebergTable {
  namespace: string[];
  name: string;
}

export interface IcebergSchema {
  type: string;
  schema_id: number;
  fields: IcebergField[];
}

export interface IcebergField {
  id: number;
  name: string;
  required: boolean;
  type: string | IcebergComplexType;
}

export interface IcebergComplexType {
  type: string;
  [key: string]: any;
}

export interface TableMetadata {
  name: string;
  namespace: string[];
  schema: IcebergSchema;
  fullMetadata?: any; // Full Iceberg metadata including snapshots, partition specs, etc.
}
