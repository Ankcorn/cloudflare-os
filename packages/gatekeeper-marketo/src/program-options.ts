// Option lists for the resource configurator pickers.

import type { MarketoClient, RawProgram } from "./marketo-api";
import type { MarketoConfiguratorOption } from "./configurator/configurator-types";

/** Most options a picker will show. Also the page size asked of Marketo for an empty query. */
export const CONFIGURATOR_LIMIT = 200;

/**
 * Resolve program picker options in a single API call.
 *
 * Marketo offers no substring search over programs, so the query is resolved three ways rather
 * than by enumerating the instance: a numeric query is a program id, text is an exact
 * case-insensitive name, and an empty query returns one browse page.
 */
export async function resolveProgramOptions(
  client: Pick<MarketoClient, "getProgramPage" | "getProgram" | "getProgramsByName">,
  query: string,
): Promise<MarketoConfiguratorOption[]> {
  let search = query.trim();
  let programs: RawProgram[];
  if (!search) {
    programs = await client.getProgramPage(CONFIGURATOR_LIMIT);
  } else if (/^\d+$/.test(search)) {
    let program = await client.getProgram(Number(search));
    programs = program ? [program] : [];
  } else {
    programs = await client.getProgramsByName(search);
  }
  return programs.slice(0, CONFIGURATOR_LIMIT).map(program => ({
    value: String(program.id),
    title: program.name ?? String(program.id),
    subtitle: [program.type, program.channel].filter(Boolean).join(" · ") || undefined,
    // Several programs can share a name, so surface the folder to tell them apart.
    meta: [program.folder?.folderName, program.workspace].filter(Boolean).join(" · ") || undefined,
  }));
}
