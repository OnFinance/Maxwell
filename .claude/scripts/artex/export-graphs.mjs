#!/usr/bin/env node
// Export ARTEX's dual-graph (asset graph + exploration graph) after task completion.
// Provides structured JSON representation of ARTEX's discoveries for Maxwell reconciliation.

import { createConnection } from 'pg';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

class GraphExportError extends Error {
  constructor(message, code = 'EXPORT_ERROR') {
    super(message);
    this.code = code;
  }
}

async function exportAssetGraph(client, taskId) {
  const query = `
    SELECT 
      ag.id,
      ag.type,
      ag.value,
      ag.discovered_at,
      ag.parent_id,
      ag.metadata,
      array_agg(DISTINCT aa.anchor_type) FILTER (WHERE aa.anchor_type IS NOT NULL) as anchor_types,
      array_agg(DISTINCT aa.intent_id) FILTER (WHERE aa.intent_id IS NOT NULL) as intent_ids
    FROM asset_graph ag
    LEFT JOIN asset_anchors aa ON aa.asset_id = ag.id
    WHERE ag.task_id = $1
    GROUP BY ag.id, ag.type, ag.value, ag.discovered_at, ag.parent_id, ag.metadata
    ORDER BY ag.discovered_at ASC
  `;

  const result = await client.query(query, [taskId]);
  
  return {
    schemaVersion: '1',
    taskId,
    exportedAt: new Date().toISOString(),
    assetCount: result.rows.length,
    assets: result.rows.map(row => ({
      id: row.id,
      type: row.type,
      value: row.value,
      discoveredAt: row.discovered_at,
      parentId: row.parent_id,
      metadata: row.metadata || {},
      anchorTypes: row.anchor_types || [],
      linkedIntents: row.intent_ids || []
    }))
  };
}

async function exportExplorationGraph(client, taskId) {
  const query = `
    SELECT 
      g.goal_id,
      g.goal_name,
      g.status as goal_status,
      g.proven_at as goal_proven_at,
      
      i.intent_id,
      i.intent_description,
      i.status as intent_status,
      i.dispatched_at as intent_dispatched_at,
      i.completed_at as intent_completed_at,
      
      f.fact_id,
      f.fact_type,
      f.fact_value,
      f.recorded_at as fact_recorded_at,
      
      fnd.finding_id,
      fnd.finding_title,
      fnd.severity,
      fnd.confidence,
      fnd.recorded_at as finding_recorded_at,
      
      h.hint_id,
      h.hint_text,
      h.priority
      
    FROM task_goals g
    LEFT JOIN exploration_intents i ON i.goal_id = g.goal_id
    LEFT JOIN exploration_facts f ON f.intent_id = i.intent_id
    LEFT JOIN exploration_findings fnd ON fnd.intent_id = i.intent_id
    LEFT JOIN exploration_hints h ON h.intent_id = i.intent_id
    WHERE g.task_id = $1
    ORDER BY 
      g.goal_id,
      i.dispatched_at NULLS LAST,
      f.recorded_at NULLS LAST,
      fnd.recorded_at NULLS LAST
  `;

  const result = await client.query(query, [taskId]);
  
  // Group by goal -> intents -> facts/findings/hints
  const goals = new Map();
  
  for (const row of result.rows) {
    if (!goals.has(row.goal_id)) {
      goals.set(row.goal_id, {
        goalId: row.goal_id,
        goalName: row.goal_name,
        status: row.goal_status,
        provenAt: row.goal_proven_at,
        intents: new Map()
      });
    }
    
    const goal = goals.get(row.goal_id);
    
    if (row.intent_id && !goal.intents.has(row.intent_id)) {
      goal.intents.set(row.intent_id, {
        intentId: row.intent_id,
        description: row.intent_description,
        status: row.intent_status,
        dispatchedAt: row.intent_dispatched_at,
        completedAt: row.intent_completed_at,
        facts: [],
        findings: [],
        hints: []
      });
    }
    
    if (row.intent_id) {
      const intent = goal.intents.get(row.intent_id);
      
      if (row.fact_id && !intent.facts.some(f => f.factId === row.fact_id)) {
        intent.facts.push({
          factId: row.fact_id,
          type: row.fact_type,
          value: row.fact_value,
          recordedAt: row.fact_recorded_at
        });
      }
      
      if (row.finding_id && !intent.findings.some(f => f.findingId === row.finding_id)) {
        intent.findings.push({
          findingId: row.finding_id,
          title: row.finding_title,
          severity: row.severity,
          confidence: row.confidence,
          recordedAt: row.finding_recorded_at
        });
      }
      
      if (row.hint_id && !intent.hints.some(h => h.hintId === row.hint_id)) {
        intent.hints.push({
          hintId: row.hint_id,
          text: row.hint_text,
          priority: row.priority
        });
      }
    }
  }
  
  return {
    schemaVersion: '1',
    taskId,
    exportedAt: new Date().toISOString(),
    goals: Array.from(goals.values()).map(goal => ({
      ...goal,
      intents: Array.from(goal.intents.values())
    }))
  };
}

async function exportToolExecutions(client, taskId) {
  const query = `
    SELECT 
      execution_id,
      worker_id,
      intent_id,
      tool_name,
      command,
      status,
      started_at,
      completed_at,
      exit_code,
      stdout_truncated,
      stderr_truncated,
      evidence_refs
    FROM worker_executions
    WHERE task_id = $1
    ORDER BY started_at ASC
  `;

  const result = await client.query(query, [taskId]);
  
  return {
    schemaVersion: '1',
    taskId,
    exportedAt: new Date().toISOString(),
    executionCount: result.rows.length,
    executions: result.rows.map(row => ({
      executionId: row.execution_id,
      workerId: row.worker_id,
      intentId: row.intent_id,
      tool: row.tool_name,
      command: row.command,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      exitCode: row.exit_code,
      stdoutTruncated: row.stdout_truncated,
      stderrTruncated: row.stderr_truncated,
      evidenceRefs: row.evidence_refs || []
    }))
  };
}

async function exportGuardInterventions(client, taskId) {
  const query = `
    SELECT 
      block_id,
      worker_id,
      intent_id,
      tool_name,
      action_type,
      blocked_reason,
      requires_human_approval,
      human_decision,
      human_decided_at,
      human_decided_by,
      created_at
    FROM guard_blocks
    WHERE task_id = $1
    ORDER BY created_at ASC
  `;

  const result = await client.query(query, [taskId]);
  
  return {
    schemaVersion: '1',
    taskId,
    exportedAt: new Date().toISOString(),
    interventionCount: result.rows.length,
    interventions: result.rows.map(row => ({
      blockId: row.block_id,
      workerId: row.worker_id,
      intentId: row.intent_id,
      tool: row.tool_name,
      actionType: row.action_type,
      blockedReason: row.blocked_reason,
      requiresHumanApproval: row.requires_human_approval,
      humanDecision: row.human_decision,
      humanDecidedAt: row.human_decided_at,
      humanDecidedBy: row.human_decided_by,
      createdAt: row.created_at
    }))
  };
}

async function exportGraphs(postgresUrl, taskId, outputDir) {
  const client = new createConnection(postgresUrl);
  
  try {
    await client.connect();
    
    console.error(`[export-graphs] Exporting graphs for task ${taskId}`);
    
    // Create output directory
    mkdirSync(outputDir, { recursive: true });
    
    // Export asset graph
    console.error(`[export-graphs] Exporting asset graph...`);
    const assetGraph = await exportAssetGraph(client, taskId);
    const assetGraphPath = join(outputDir, 'asset-graph.json');
    writeFileSync(assetGraphPath, JSON.stringify(assetGraph, null, 2));
    console.error(`[export-graphs] Asset graph: ${assetGraph.assetCount} assets`);
    
    // Export exploration graph
    console.error(`[export-graphs] Exporting exploration graph...`);
    const explorationGraph = await exportExplorationGraph(client, taskId);
    const explorationGraphPath = join(outputDir, 'exploration-graph.json');
    writeFileSync(explorationGraphPath, JSON.stringify(explorationGraph, null, 2));
    console.error(`[export-graphs] Exploration graph: ${explorationGraph.goals.length} goals`);
    
    // Export tool executions
    console.error(`[export-graphs] Exporting tool executions...`);
    const toolExecutions = await exportToolExecutions(client, taskId);
    const toolExecutionsPath = join(outputDir, 'tool-executions.json');
    writeFileSync(toolExecutionsPath, JSON.stringify(toolExecutions, null, 2));
    console.error(`[export-graphs] Tool executions: ${toolExecutions.executionCount} executions`);
    
    // Export guard interventions
    console.error(`[export-graphs] Exporting guard interventions...`);
    const guardInterventions = await exportGuardInterventions(client, taskId);
    const guardInterventionsPath = join(outputDir, 'guard-interventions.json');
    writeFileSync(guardInterventionsPath, JSON.stringify(guardInterventions, null, 2));
    console.error(`[export-graphs] Guard interventions: ${guardInterventions.interventionCount} interventions`);
    
    // Calculate combined SHA-256
    const combinedContent = JSON.stringify({
      assetGraph,
      explorationGraph,
      toolExecutions,
      guardInterventions
    });
    const sha256 = createHash('sha256').update(combinedContent).digest('hex');
    
    // Write metadata
    const metadata = {
      taskId,
      exportedAt: new Date().toISOString(),
      files: {
        assetGraph: 'asset-graph.json',
        explorationGraph: 'exploration-graph.json',
        toolExecutions: 'tool-executions.json',
        guardInterventions: 'guard-interventions.json'
      },
      stats: {
        assets: assetGraph.assetCount,
        goals: explorationGraph.goals.length,
        intents: explorationGraph.goals.reduce((sum, g) => sum + g.intents.length, 0),
        executions: toolExecutions.executionCount,
        guardInterventions: guardInterventions.interventionCount
      },
      sha256
    };
    
    const metadataPath = join(outputDir, 'export-metadata.json');
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
    
    console.error(`[export-graphs] Export complete. SHA-256: ${sha256}`);
    
    return {
      success: true,
      outputDir,
      metadata
    };
    
  } catch (err) {
    throw new GraphExportError(`Failed to export graphs: ${err.message}`);
  } finally {
    await client.end();
  }
}

// Main execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.length < 6) {
    console.error('Usage: node export-graphs.mjs --task <task-id> --postgres <url> --output <dir>');
    console.error('');
    console.error('Export ARTEX dual-graph after task completion.');
    console.error('');
    console.error('Options:');
    console.error('  --task <id>       ARTEX task ID');
    console.error('  --postgres <url>  PostgreSQL connection URL');
    console.error('  --output <dir>    Output directory for JSON exports');
    process.exit(1);
  }
  
  const taskIdx = args.indexOf('--task');
  const postgresIdx = args.indexOf('--postgres');
  const outputIdx = args.indexOf('--output');
  
  if (taskIdx === -1 || postgresIdx === -1 || outputIdx === -1) {
    console.error('ERROR: Missing required arguments');
    process.exit(1);
  }
  
  const taskId = args[taskIdx + 1];
  const postgresUrl = args[postgresIdx + 1];
  const outputDir = args[outputIdx + 1];
  
  try {
    const result = await exportGraphs(postgresUrl, taskId, outputDir);
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
}

export { exportGraphs, GraphExportError };
