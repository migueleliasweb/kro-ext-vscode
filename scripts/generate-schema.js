const fs = require('fs');
const path = require('path');
const https = require('https');
const { parse } = require('yaml');

const CRD_URL = 'https://raw.githubusercontent.com/kubernetes-sigs/kro/main/helm/crds/kro.run_resourcegraphdefinitions.yaml';
const OUTPUT_PATH = path.join(__dirname, '..', 'schemas', 'rgd-schema.json');

function fetchCRD(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to fetch CRD: status code ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function run() {
  try {
    console.log(`Fetching KRO upstream CRD from: ${CRD_URL}`);
    const yamlText = await fetchCRD(CRD_URL);
    
    console.log('Parsing CRD YAML...');
    const crd = parse(yamlText);

    if (!crd || crd.kind !== 'CustomResourceDefinition') {
      throw new Error('Fetched file is not a CustomResourceDefinition');
    }

    const versions = crd.spec.versions;
    if (!versions || versions.length === 0) {
      throw new Error('No versions found in CRD');
    }

    // Use the first/latest version
    const version = versions[0];
    const openSchema = version.schema.openAPIV3Schema;

    if (!openSchema) {
      throw new Error(`No openAPIV3Schema found for version ${version.name}`);
    }

    console.log(`Found version schema for: ${version.name}`);

    // Build standard JSON schema Draft-07
    const jsonSchema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      title: 'ResourceGraphDefinition',
      description: openSchema.description || 'Kubernetes Resource Operator (kro) ResourceGraphDefinition manifest',
      type: 'object',
      required: openSchema.required || ['apiVersion', 'kind', 'metadata', 'spec'],
      properties: { ...openSchema.properties }
    };

    // Enhance schema for better editor completion by injecting enums
    if (jsonSchema.properties.apiVersion) {
      jsonSchema.properties.apiVersion.enum = [`kro.run/${version.name}`];
    }
    if (jsonSchema.properties.kind) {
      jsonSchema.properties.kind.enum = ['ResourceGraphDefinition'];
    }

    // Ensure metadata name is required
    if (jsonSchema.properties.metadata && typeof jsonSchema.properties.metadata === 'object') {
      jsonSchema.properties.metadata.required = ['name'];
      jsonSchema.properties.metadata.properties = jsonSchema.properties.metadata.properties || {};
      jsonSchema.properties.metadata.properties.name = {
        type: 'string',
        description: 'Name of the ResourceGraphDefinition'
      };
    }

    // Clean up or adjust x-kubernetes properties if necessary, but keeping them is fine.
    // Ensure the output directory exists
    const dir = path.dirname(OUTPUT_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    console.log(`Writing JSON schema to: ${OUTPUT_PATH}`);
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(jsonSchema, null, 2), 'utf8');
    console.log('Successfully generated JSON schema!');
  } catch (err) {
    console.error('Error generating schema:', err);
    process.exit(1);
  }
}

run();
