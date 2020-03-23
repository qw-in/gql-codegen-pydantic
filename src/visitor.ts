/* eslint-disable lines-between-class-members */
/* eslint-disable class-methods-use-this */
/* eslint-disable react/no-this-in-sfc */
import {
  BaseVisitor,
  ParsedConfig,
  buildScalars,
  indent,
} from '@graphql-codegen/visitor-plugin-common';
import {
  NamedTypeNode,
  ListTypeNode,
  NonNullTypeNode,
  GraphQLSchema,
  FieldDefinitionNode,
  ObjectTypeDefinitionNode,
  NameNode,
  UnionTypeDefinitionNode,
  DocumentNode,
  InterfaceTypeDefinitionNode,
  EnumTypeDefinitionNode,
} from 'graphql';
import { snakeCase } from 'change-case';
import { DepGraph } from 'dependency-graph';

import { PydanticPluginRawConfig } from './config';

export const PYTHON_SCALARS = {
  ID: 'str',
  String: 'str',
  Boolean: 'bool',
  Int: 'int',
  Float: 'float',
};

const PYDANTIC_MODEL_RESERVED = ['copy'];

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface PydanticPluginParsedConfig extends ParsedConfig {
  /* intentionally empty for now */
}

export class PydanticVisitor extends BaseVisitor<
  PydanticPluginRawConfig,
  PydanticPluginParsedConfig
> {
  private addOptionalImport = false;
  private addAnyImport = false;
  private addListImport = false;
  private addUnionImport = false;
  private addEnumImport = false;
  private addFieldImport = false;

  private graph = new DepGraph({
    circular: false,
  });

  constructor(
    rawConfig: PydanticPluginRawConfig,
    private schema: GraphQLSchema,
  ) {
    super(rawConfig, {
      // enumValues: rawConfig.enumValues || {},
      // listType: rawConfig.listType || 'List',
      // package: rawConfig.package || defaultPackageName,
      scalars: buildScalars(schema, {}, PYTHON_SCALARS),
    });
  }

  public getImports(): string {
    const typing = [];
    const pydantic = ['BaseModel'];

    if (this.addAnyImport) {
      typing.push(`Any`);
    }

    if (this.addOptionalImport) {
      typing.push(`Optional`);
    }

    if (this.addListImport) {
      typing.push(`List`);
    }

    if (this.addUnionImport) {
      typing.push(`Union`);
    }

    if (this.addFieldImport) {
      pydantic.push(`Field`);
    }

    const enumInput = this.addEnumImport ? 'from enum import Enum' : '';

    const typingImport = typing.length
      ? `from typing import ${typing.join(', ')}`
      : '';

    const pydanticImport = pydantic.length
      ? `from pydantic import ${pydantic.join(', ')}`
      : '';

    return [enumInput, typingImport, pydanticImport].filter(i => i).join('\n');
  }

  protected canAddGraphNode(id: string): boolean {
    if (this.graph.hasNode(id)) {
      return false;
    }

    if (Object.values(this.scalars).includes(id) || id === 'Any') {
      return false;
    }

    return true;
  }

  protected upsertGraphNode(id: string) {
    if (this.canAddGraphNode(id)) {
      this.graph.addNode(id);
    }
  }

  protected addGraphNodeDeps(id: string, ids: string[]) {
    if (!this.canAddGraphNode(id)) {
      return;
    }

    this.graph.addNode(id);

    ids.forEach((i: string) => {
      if (!this.canAddGraphNode(i)) {
        return;
      }

      this.graph.addNode(i);

      this.graph.addDependency(id, i);
    });
  }

  protected clearOptional(str: string): string {
    if (str.startsWith('Optional[')) {
      return str.replace(/Optional\[(.*?)\]$/, '$1');
    }

    return str;
  }

  Name(node: NameNode) {
    return node.value;
  }

  NamedType(node: NamedTypeNode) {
    const { name } = node as any;

    // Scalars
    if (Object.keys(this.scalars).includes(name)) {
      const id = this.scalars[name];

      // Special case for any
      if (id === 'any') {
        this.addAnyImport = true;
        return {
          id: 'Any',
          source: 'Any',
        };
      }

      this.addOptionalImport = true;
      return {
        id,
        source: `Optional[${id}]`,
      };
    }

    // Defined
    this.addOptionalImport = true;
    return {
      id: name,
      source: `Optional['${name}']`,
    };
  }

  ListType(node: ListTypeNode) {
    this.addListImport = true;
    this.addOptionalImport = true;

    const { type } = node as any;

    return {
      id: type.id,
      source: `Optional[List[${type.source}]]`,
    };
  }

  NonNullType(node: NonNullTypeNode) {
    const { type } = node as any;

    return {
      id: type.id,
      source: this.clearOptional(type.source),
    };
  }

  FieldDefinition(node: FieldDefinitionNode) {
    const argName = snakeCase(node.name as any);

    const { type } = node as any;

    // Need to alias some field names
    // Otherwise pydantic throws
    if (PYDANTIC_MODEL_RESERVED.includes(argName)) {
      this.addFieldImport = true;
      return {
        id: type.id,
        source: indent(
          `${argName}_: ${type.source} = Field(None, alias='${argName}')`,
          2,
        ),
      };
    }

    return {
      id: type.id,
      source: indent(`${argName}: ${type.source}`, 2),
    };
  }

  EnumTypeDefinition(node: EnumTypeDefinitionNode) {
    this.addEnumImport = true;

    const { name, values } = node as any;

    const val = values
      .map((v: any) => indent(`${v.name} = '${v.name}'`, 2))
      .join('\n');
    const source = `class ${name}(str, Enum):\n${val}`;

    this.upsertGraphNode(name);

    return {
      id: name,
      source,
    };
  }

  UnionTypeDefinition(node: UnionTypeDefinitionNode) {
    this.addUnionImport = true;

    const { name, types } = node as any;

    const unionTypes = (types ?? []).map((t: any) =>
      this.clearOptional(t.source),
    );

    this.addGraphNodeDeps(
      name,
      types.map((t: any) => t.id),
    );

    return {
      id: name,
      source: `${name} = Union[${unionTypes.join(', ')}]`,
    };
  }

  InterfaceTypeDefinition(node: InterfaceTypeDefinitionNode) {
    const { name, fields } = node as any;

    const args = fields.map((f: any) => f.source).join('\n');
    const source = `class ${name}(BaseModel):\n${args}`;

    this.addGraphNodeDeps(
      name,
      fields.map((f: any) => f.id),
    );

    return {
      id: name,
      source,
    };
  }

  ObjectTypeDefinition(node: ObjectTypeDefinitionNode) {
    const { name, fields, interfaces: rawInterfaces } = node as any;

    const interfaces = rawInterfaces.map((n: any) =>
      this.clearOptional(n.source).replace(/'/g, ''),
    );

    const impl = interfaces.length ? interfaces.join(', ') : 'BaseModel';

    const args = fields.map((f: any) => f.source).join('\n');
    const source = `class ${name}(${impl}):\n${args}`;

    if (interfaces.length) {
      this.addGraphNodeDeps(name, interfaces);
    } else {
      this.upsertGraphNode(name);
    }

    return {
      id: name,
      source,
    };
  }

  Document(node: DocumentNode) {
    const { definitions } = node as any;

    const nodesInOrder = this.graph.overallOrder();

    return nodesInOrder
      .map((n: any) => definitions.find((d: any) => d.id === n)?.source || '')
      .join('\n\n\n');
  }
}
