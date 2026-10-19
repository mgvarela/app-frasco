import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./supabase-config.js";

const PAGE_SIZE = 12;
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const CATEGORIES = {
  jars: "Frascos con tapa",
  bottles: "Botellas",
  bulk: "Lotes para emprendimientos",
  other: "Otros envases de vidrio"
};
const CONDITIONS = {
  excellent: "Excelente",
  good: "Bueno",
  fair: "Con marcas de uso"
};
const LID_CONDITIONS = {
  included: "Tapas incluidas",
  not_included: "Sin tapas",
  not_applicable: "No aplica",
  unknown: "Tapas no especificadas"
};

const state = {
  supabase: null,
  session: null,
  profile: null,
  page: 1,
  hasNextPage: false,
  favorites: new Set(),
  signedImageUrls: new Map(),
  authMode: "signin",
  toastTimer: null
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const formValues = form => Object.fromEntries(new FormData(form).entries());

function showToast(message, isError = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.hidden = false;
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => { toast.hidden = true; }, 5500);
}

function showStatus(message, isError = false) {
  const status = $("#app-status");
  status.textContent = message;
  status.classList.toggle("error", isError);
  status.hidden = false;
}

function clearStatus() {
  $("#app-status").hidden = true;
  $("#app-status").textContent = "";
}

function reportError(context, error, message) {
  console.error(`[Frasco] ${context}`, error);
  showToast(message, true);
}

function requireClient() {
  if (!state.supabase) {
    showToast("La conexión a Supabase todavía no está configurada. Seguí la guía de instalación.", true);
    return false;
  }
  return true;
}

function formatPrice(value) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0
  }).format(value);
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

async function getImageUrl(path) {
  const cached = state.signedImageUrls.get(path);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  const { data, error } = await state.supabase.storage
    .from("listing-images")
    .createSignedUrl(path, 300);
  if (error) throw error;
  state.signedImageUrls.set(path, { url: data.signedUrl, expiresAt: Date.now() + 240000 });
  return data.signedUrl;
}

async function loadPrivateImage(image, path) {
  try {
    const url = await getImageUrl(path);
    if (image.isConnected) image.src = url;
  } catch (error) {
    console.error("[Frasco] No se pudo cargar una foto del anuncio", error);
    if (image.isConnected) {
      image.remove();
      showStatus("No se pudo cargar una de las fotos. Actualizá la página o contactá al administrador si el problema continúa.", true);
    }
  }
}

function openDialog(dialog) {
  if (!dialog.open) dialog.showModal();
  document.body.classList.add("dialog-open");
}

function closeDialog(dialog) {
  if (dialog.open) dialog.close();
  if (!$(".dialog[open]")) document.body.classList.remove("dialog-open");
}

function setAuthMode(mode) {
  state.authMode = mode;
  const signup = mode === "signup";
  const recovery = mode === "recovery";
  $("#auth-heading").textContent = recovery ? "Elegí una nueva contraseña" : signup ? "Crear cuenta" : "Ingresar";
  $("#auth-submit").textContent = recovery ? "Actualizar contraseña" : signup ? "Crear cuenta" : "Ingresar";
  $("#auth-tabs").hidden = recovery;
  $("#password-field").querySelector("input").autocomplete = recovery ? "new-password" : "current-password";
  $("#password-field").querySelector("input").value = "";
  $$(".tab").forEach(tab => tab.classList.toggle("active", tab.dataset.authMode === mode));
  $$(".signup-field").forEach(field => {
    field.hidden = !signup;
    const input = $("input", field);
    input.required = signup && field.textContent.includes("Nombre visible");
  });
  $("#password-field").hidden = false;
  $("#forgot-password").hidden = signup || recovery;
  $("#auth-message").textContent = "";
}

function renderSession() {
  const signedIn = Boolean(state.session);
  $("#sign-in-open").hidden = signedIn;
  $("#account-link").hidden = !signedIn;
  $("#account-link").textContent = signedIn ? "Mi cuenta" : "Ingresar";
  $("#my-account").hidden = !signedIn;
  $("#moderation-panel").hidden = !["admin", "moderator"].includes(state.profile?.role);
  if (signedIn && state.profile) {
    const profileForm = $("#profile-form");
    profileForm.elements.display_name.value = state.profile.display_name ?? "";
    profileForm.elements.whatsapp_number.value = state.profile.whatsapp_number ?? "";
    profileForm.elements.contact_public.checked = Boolean(state.profile.contact_public);
  }
}

async function getSession() {
  const { data, error } = await state.supabase.auth.getSession();
  if (error) throw error;
  state.session = data.session;
  if (!state.session) {
    state.profile = null;
    state.favorites.clear();
    renderSession();
    return;
  }

  const { data: profile, error: profileError } = await state.supabase
    .from("profiles")
    .select("id, display_name, whatsapp_number, contact_public")
    .eq("id", state.session.user.id)
    .single();
  if (profileError) throw profileError;
  const { data: role, error: roleError } = await state.supabase.rpc("current_user_role");
  if (roleError) throw roleError;
  state.profile = { ...profile, role };
  renderSession();
  await loadFavorites();
}

async function loadFavorites() {
  if (!state.session) return;
  const { data, error } = await state.supabase
    .from("favorites")
    .select("listing_id")
    .eq("user_id", state.session.user.id);
  if (error) throw error;
  state.favorites = new Set(data.map(item => item.listing_id));
}

function listingDescription(listing) {
  const details = [
    CONDITIONS[listing.glass_condition] ?? "Estado no especificado",
    LID_CONDITIONS[listing.lid_condition] ?? null,
    listing.capacity_ml ? `${listing.capacity_ml} ml` : null,
    listing.dimensions || null,
    `${listing.quantity} disponibles`,
    listing.location_label
  ].filter(Boolean);
  return details.join(" · ");
}

function createListingCard(listing) {
  const article = makeElement("article", "product");
  const art = makeElement("div", "product-art");
  const tag = makeElement("span", "tag", listing.price_unit === "unit" ? "Por unidad" : "Por lote");
  art.append(tag);
  if (listing.image_paths?.length) {
    const image = document.createElement("img");
    image.src = publicImageUrl(listing.image_paths[0]);
    image.alt = `Foto de ${listing.title}`;
    image.loading = "lazy";
    art.append(image);
    void loadPrivateImage(image, listing.image_paths[0]);
  } else {
    const jar = makeElement("div", `jar ${listing.category === "bottles" ? "tall" : ""}`);
    const label = makeElement("span", "labeljar", "VIDRIO");
    jar.append(label);
    art.append(jar);
  }

  const info = makeElement("div", "product-info");
  const title = makeElement("h3", "", listing.title);
  const meta = makeElement("div", "meta", listingDescription(listing));
  const priceRow = makeElement("div", "price-row");
  const price = makeElement("div", "price", formatPrice(listing.price_ars));
  const priceUnit = makeElement("small", "", listing.price_unit === "unit" ? " / unidad" : " / lote");
  price.append(priceUnit);
  const detailsButton = makeElement("button", "btn secondary", "Ver publicación");
  detailsButton.type = "button";
  detailsButton.addEventListener("click", () => showListingDetail(listing));
  priceRow.append(price, detailsButton);
  const category = makeElement("div", "meta", CATEGORIES[listing.category] ?? "Envase de vidrio");
  const location = makeElement("div", "location", `Zona aproximada: ${listing.location_label}`);
  info.append(title, meta, category, priceRow, location);

  const actions = makeElement("div", "card-actions");
  if (state.session && listing.owner_id !== state.session.user.id) {
    const favorite = makeElement("button", "btn secondary", state.favorites.has(listing.id) ? "♥ Guardado" : "♡ Favorito");
    favorite.type = "button";
    favorite.addEventListener("click", () => toggleFavorite(listing));
    actions.append(favorite);
  }
  if (state.session && listing.owner_id !== state.session.user.id) {
    const report = makeElement("button", "btn secondary", "Reportar");
    report.type = "button";
    report.addEventListener("click", () => openReport(listing.id));
    actions.append(report);
  }
  if (actions.childElementCount) info.append(actions);
  article.append(art, info);
  return article;
}

function renderListings(listings) {
  const grid = $("#listing-grid");
  grid.replaceChildren(...listings.map(createListingCard));
  $("#empty-state").hidden = listings.length > 0;
  $("#empty-title").textContent = listings.length ? "" : "No encontramos publicaciones con esos filtros.";
  $("#empty-copy").textContent = listings.length
    ? ""
    : "Probá cambiar los filtros o volvé más tarde. También podés ser la primera persona en publicar.";
  $("#page-label").textContent = `Página ${state.page}`;
  $("#previous-page").disabled = state.page <= 1;
  $("#next-page").disabled = !state.hasNextPage;
}

function validateFilters(values) {
  const min = values.price_min ? Number(values.price_min) : null;
  const max = values.price_max ? Number(values.price_max) : null;
  const quantity = values.quantity_min ? Number(values.quantity_min) : null;
  if ((min !== null && (!Number.isSafeInteger(min) || min < 0))
    || (max !== null && (!Number.isSafeInteger(max) || max < 0))
    || (quantity !== null && (!Number.isSafeInteger(quantity) || quantity < 1))) {
    showToast("Revisá los filtros numéricos.", true);
    return false;
  }
  if (min !== null && max !== null && min > max) {
    showToast("El precio mínimo no puede superar el máximo.", true);
    return false;
  }
  return true;
}

async function loadListings() {
  if (!state.supabase) return;
  const values = formValues($("#filters"));
  if (!validateFilters(values)) return;
  clearStatus();
  const { data, error } = await state.supabase.rpc("search_active_listings", {
    p_query: values.q?.trim() || null,
    p_category: values.category || null,
    p_price_min: values.price_min ? Number(values.price_min) : null,
    p_price_max: values.price_max ? Number(values.price_max) : null,
    p_quantity_min: values.quantity_min ? Number(values.quantity_min) : null,
    p_location: values.location?.trim() || null,
    p_sort: values.sort || "recent",
    p_page: state.page,
    p_page_size: PAGE_SIZE + 1
  });
  if (error) throw error;
  state.hasNextPage = data.length > PAGE_SIZE;
  renderListings(data.slice(0, PAGE_SIZE));
}

function showListingDetail(listing) {
  const content = $("#detail-content");
  content.replaceChildren();
  const eyebrow = makeElement("div", "eyebrow", CATEGORIES[listing.category] ?? "Envase de vidrio");
  const title = makeElement("h2", "", listing.title);
  const price = makeElement("p", "price", `${formatPrice(listing.price_ars)} ${listing.price_unit === "unit" ? "por unidad" : "por lote"}`);
  const meta = makeElement("p", "meta", listingDescription(listing));
  const description = makeElement("p", "detail-copy", listing.description);
  const images = makeElement("div", "detail-images");
  (listing.image_paths ?? []).forEach((path, index) => {
    const image = document.createElement("img");
    image.alt = `Foto ${index + 1} de ${listing.title}`;
    image.loading = "lazy";
    images.append(image);
    void loadPrivateImage(image, path);
  });
  content.append(eyebrow, title, price, meta, images, description);

  const seller = makeElement("p", "meta", `Publicado por ${listing.owner_name || "Usuario Frasco"}`);
  content.append(seller);
  if (listing.owner_whatsapp) {
    const phone = listing.owner_whatsapp.replace(/\D/g, "");
    if (/^\d{8,15}$/.test(phone)) {
      const message = encodeURIComponent(`Hola, vi en Frasco la publicación "${listing.title}". ¿Sigue disponible?`);
      const contact = makeElement("a", "btn", "Consultar por WhatsApp");
      contact.href = `https://wa.me/${phone}?text=${message}`;
      contact.target = "_blank";
      contact.rel = "noopener noreferrer";
      content.append(contact);
    }
  }
  openDialog($("#detail-dialog"));
}

function openAuth(mode = "signin") {
  setAuthMode(mode);
  openDialog($("#auth-dialog"));
}

async function openCreateListing(listing = null) {
  if (!requireClient()) return;
  if (!state.session) {
    openAuth("signin");
    showToast("Ingresá o creá una cuenta para publicar.");
    return;
  }
  const form = $("#listing-form");
  form.reset();
  form.elements.id.value = listing?.id ?? "";
  if (listing) {
    form.elements.title.value = listing.title;
    form.elements.category.value = listing.category;
    form.elements.description.value = listing.description;
    form.elements.price_ars.value = listing.price_ars;
    form.elements.price_unit.value = listing.price_unit;
    form.elements.quantity.value = listing.quantity;
    form.elements.capacity_ml.value = listing.capacity_ml ?? "";
    form.elements.dimensions.value = listing.dimensions ?? "";
    form.elements.glass_condition.value = listing.glass_condition;
    form.elements.lid_condition.value = listing.lid_condition;
    form.elements.location_label.value = listing.location_label;
    $("#listing-heading").textContent = "Editar publicación";
    $("#listing-message").textContent = "Las fotos nuevas se agregan a las existentes.";
  } else {
    $("#listing-heading").textContent = "Mostrá tus envases";
    $("#listing-message").textContent = "";
  }
  openDialog($("#listing-dialog"));
}

function validateImages(files, existingCount = 0) {
  if (existingCount + files.length > MAX_IMAGES) {
    throw new Error(`Podés publicar hasta ${MAX_IMAGES} fotos en total.`);
  }
  for (const file of files) {
    if (!IMAGE_TYPES.has(file.type)) throw new Error("Usá fotos JPG, PNG o WebP.");
    if (file.size > MAX_IMAGE_BYTES) throw new Error("Cada foto debe pesar 5 MB o menos.");
  }
}

async function uploadListingImages(listingId, files) {
  for (const file of files) {
    const extension = file.type === "image/jpeg" ? "jpg" : file.type.split("/")[1];
    const path = `${state.session.user.id}/${listingId}/${crypto.randomUUID()}.${extension}`;
    const { error: uploadError } = await state.supabase.storage
      .from("listing-images")
      .upload(path, file, { contentType: file.type, upsert: false });
    if (uploadError) throw uploadError;
    const { error: imageError } = await state.supabase
      .from("listing_images")
      .insert({ listing_id: listingId, storage_path: path });
    if (imageError) throw imageError;
  }
}

async function saveListing(event) {
  event.preventDefault();
  if (!requireClient() || !state.session) return;
  const form = event.currentTarget;
  const submit = $('button[type="submit"]', form);
  const values = formValues(form);
  const files = [...form.elements.images.files];
  submit.disabled = true;
  $("#listing-message").textContent = "";
  try {
    validateImages(files);
    let imageCount = 0;
    if (values.id) {
      const { count, error } = await state.supabase
        .from("listing_images")
        .select("id", { count: "exact", head: true })
        .eq("listing_id", values.id);
      if (error) throw error;
      imageCount = count ?? 0;
    }
    validateImages(files, imageCount);
    const payload = {
      title: values.title.trim(),
      description: values.description.trim(),
      category: values.category,
      price_ars: Number(values.price_ars),
      price_unit: values.price_unit,
      quantity: Number(values.quantity),
      capacity_ml: values.capacity_ml ? Number(values.capacity_ml) : null,
      dimensions: values.dimensions.trim() || null,
      glass_condition: values.glass_condition,
      lid_condition: values.lid_condition,
      location_label: values.location_label.trim()
    };
    if (values.id) {
      const { error } = await state.supabase.from("listings").update(payload).eq("id", values.id);
      if (error) throw error;
    } else {
      const { data, error } = await state.supabase
        .from("listings")
        .insert({ ...payload, owner_id: state.session.user.id })
        .select("id")
        .single();
      if (error) throw error;
      values.id = data.id;
    }
    if (files.length) await uploadListingImages(values.id, files);
    $("#listing-message").textContent = "Publicación guardada.";
    showToast("La publicación quedó guardada.");
    closeDialog($("#listing-dialog"));
    await loadListings();
    await loadMyListings();
  } catch (error) {
    reportError("No se pudo guardar la publicación", error, error.message?.startsWith("Podés") || error.message?.startsWith("Usá") || error.message?.startsWith("Cada")
      ? error.message
      : "No se pudo guardar la publicación. Revisá tu conexión e intentá de nuevo.");
    $("#listing-message").textContent = "Si el anuncio se creó antes del error, revisalo en «Mis publicaciones» antes de volver a publicarlo.";
    if (state.session) await loadMyListings();
  } finally {
    submit.disabled = false;
  }
}

async function toggleFavorite(listing) {
  if (!requireClient()) return;
  if (!state.session) {
    openAuth("signin");
    return;
  }
  const exists = state.favorites.has(listing.id);
  const result = exists
    ? await state.supabase.from("favorites").delete().eq("listing_id", listing.id).eq("user_id", state.session.user.id)
    : await state.supabase.from("favorites").insert({ listing_id: listing.id, user_id: state.session.user.id });
  if (result.error) {
    reportError("No se pudo actualizar el favorito", result.error, "No se pudo actualizar el favorito.");
    return;
  }
  if (exists) state.favorites.delete(listing.id);
  else state.favorites.add(listing.id);
  await loadListings();
  await loadMyFavorites();
}

function openReport(listingId) {
  if (!state.session) {
    openAuth("signin");
    return;
  }
  const form = $("#report-form");
  form.reset();
  form.elements.listing_id.value = listingId;
  $("#report-message").textContent = "";
  openDialog($("#report-dialog"));
}

async function submitReport(event) {
  event.preventDefault();
  if (!requireClient() || !state.session) return;
  const form = event.currentTarget;
  const values = formValues(form);
  const { error } = await state.supabase.from("reports").insert({
    listing_id: values.listing_id,
    reporter_id: state.session.user.id,
    reason: values.reason,
    details: values.details.trim() || null
  });
  if (error) {
    reportError("No se pudo enviar el reporte", error, error.code === "23505"
      ? "Ya reportaste esta publicación."
      : "No se pudo enviar el reporte. Intentá de nuevo más tarde.");
    return;
  }
  $("#report-message").textContent = "Gracias. El reporte fue enviado para revisión.";
  showToast("Reporte enviado.");
  closeDialog($("#report-dialog"));
}

async function loadMyListings() {
  if (!state.session) return;
  const { data, error } = await state.supabase
    .from("listings")
    .select("id, title, status, price_ars, price_unit, quantity")
    .eq("owner_id", state.session.user.id)
    .order("created_at", { ascending: false });
  if (error) throw error;
  const container = $("#my-listings");
  container.replaceChildren();
  if (!data.length) {
    container.append(makeElement("p", "hint", "Todavía no publicaste anuncios."));
    return;
  }
  for (const listing of data) {
    const item = makeElement("article", "manage-item");
    const text = makeElement("div");
    const title = makeElement("h4", "", listing.title);
    const status = makeElement("p", "meta", `${listing.status === "active" ? "Activo" : listing.status === "sold" ? "Vendido" : "Archivado"} · ${formatPrice(listing.price_ars)}`);
    text.append(title, status);
    const actions = makeElement("div", "manage-actions");
    const edit = makeElement("button", "btn secondary", "Editar");
    edit.type = "button";
    edit.addEventListener("click", async () => {
      try {
        const { data: fullListing, error: fetchError } = await state.supabase
          .from("listings")
          .select("*, listing_images(storage_path)")
          .eq("id", listing.id)
          .single();
        if (fetchError) throw fetchError;
        await openCreateListing({ ...fullListing, image_paths: fullListing.listing_images.map(image => image.storage_path) });
      } catch (error) {
        reportError("No se pudo abrir la publicación", error, "No se pudo cargar la publicación para editar.");
      }
    });
    actions.append(edit);

    const nextStatus = listing.status === "active" ? "archived" : "active";
    const toggle = makeElement("button", "btn secondary", listing.status === "active" ? "Archivar" : listing.status === "sold" ? "Reactivar" : "Reactivar");
    toggle.type = "button";
    toggle.addEventListener("click", () => updateListingStatus(listing.id, nextStatus));
    actions.append(toggle);
    if (listing.status === "active") {
      const sold = makeElement("button", "btn secondary", "Marcar vendido");
      sold.type = "button";
      sold.addEventListener("click", () => updateListingStatus(listing.id, "sold"));
      actions.append(sold);
    }
    const remove = makeElement("button", "btn secondary", "Eliminar");
    remove.type = "button";
    remove.addEventListener("click", () => deleteListing(listing.id));
    actions.append(remove);
    item.append(text, actions);
    container.append(item);
  }
}

async function updateListingStatus(listingId, status) {
  const { error } = await state.supabase.from("listings").update({ status }).eq("id", listingId);
  if (error) {
    reportError("No se pudo cambiar el estado", error, "No se pudo cambiar el estado de la publicación.");
    return;
  }
  await Promise.all([loadMyListings(), loadListings(), loadMyFavorites()]);
}

async function deleteListing(listingId) {
  if (!window.confirm("¿Eliminar esta publicación de forma permanente?")) return;
  try {
    const { data: images, error: imagesError } = await state.supabase
      .from("listing_images")
      .select("storage_path")
      .eq("listing_id", listingId);
    if (imagesError) throw imagesError;
    const { error } = await state.supabase.from("listings").delete().eq("id", listingId);
    if (error) throw error;
    if (images.length) {
      const { error: storageError } = await state.supabase.storage
        .from("listing-images")
        .remove(images.map(image => image.storage_path));
      if (storageError) {
        reportError("La publicación se eliminó pero algunas imágenes quedaron en almacenamiento", storageError, "La publicación se eliminó, pero no se pudieron limpiar todas las fotos. Contactá al administrador.");
      }
    }
    showToast("Publicación eliminada.");
    await Promise.all([loadMyListings(), loadListings(), loadMyFavorites()]);
  } catch (error) {
    reportError("No se pudo eliminar la publicación", error, "No se pudo eliminar la publicación.");
  }
}

async function loadMyFavorites() {
  if (!state.session) return;
  const { data, error } = await state.supabase
    .from("favorites")
    .select("listing_id, listings(id, title, status, price_ars, price_unit)")
    .eq("user_id", state.session.user.id);
  if (error) throw error;
  const container = $("#my-favorites");
  container.replaceChildren();
  const active = data.filter(item => item.listings?.status === "active");
  if (!active.length) {
    container.append(makeElement("p", "hint", "Tus publicaciones guardadas van a aparecer acá."));
    return;
  }
  active.forEach(({ listing_id: id, listings: listing }) => {
    const item = makeElement("article", "manage-item");
    const text = makeElement("div");
    text.append(makeElement("h4", "", listing.title), makeElement("p", "meta", formatPrice(listing.price_ars)));
    const remove = makeElement("button", "btn secondary", "Quitar");
    remove.type = "button";
    remove.addEventListener("click", () => toggleFavorite({ id }));
    item.append(text, remove);
    container.append(item);
  });
}

async function loadReports() {
  if (!["admin", "moderator"].includes(state.profile?.role)) return;
  const { data, error } = await state.supabase
    .from("reports")
    .select("id, listing_id, reason, details, status, created_at, listings(title)")
    .eq("status", "open")
    .order("created_at", { ascending: true });
  if (error) throw error;
  const container = $("#reports-list");
  container.replaceChildren();
  if (!data.length) {
    container.append(makeElement("p", "hint", "No hay reportes abiertos."));
    return;
  }
  data.forEach(report => {
    const item = makeElement("article", "manage-item");
    const text = makeElement("div");
    text.append(
      makeElement("h4", "", report.listings?.title ?? "Publicación eliminada"),
      makeElement("p", "meta", `${report.reason} · ${report.details || "Sin detalle"}`)
    );
    const actions = makeElement("div", "manage-actions");
    for (const [status, label] of [["reviewed", "Revisado"], ["dismissed", "Descartar"]]) {
      const button = makeElement("button", "btn secondary", label);
      button.type = "button";
      button.addEventListener("click", () => updateReport(report.id, status));
      actions.append(button);
    }
    item.append(text, actions);
    container.append(item);
  });
}

async function updateReport(reportId, status) {
  const { error } = await state.supabase.from("reports").update({ status }).eq("id", reportId);
  if (error) {
    reportError("No se pudo actualizar el reporte", error, "No se pudo actualizar el reporte.");
    return;
  }
  await loadReports();
}

async function loadAccountData() {
  if (!state.session) return;
  try {
    await Promise.all([loadMyListings(), loadMyFavorites(), loadReports()]);
  } catch (error) {
    reportError("No se pudieron cargar los datos de la cuenta", error, "No se pudieron cargar todos los datos de tu cuenta.");
  }
}

async function submitAuth(event) {
  event.preventDefault();
  if (!requireClient()) return;
  const form = event.currentTarget;
  const values = formValues(form);
  const submit = $("#auth-submit");
  submit.disabled = true;
  $("#auth-message").textContent = "";
  try {
    if (state.authMode === "recovery") {
      const { error } = await state.supabase.auth.updateUser({ password: values.password });
      if (error) throw error;
      $("#auth-message").textContent = "Contraseña actualizada. Ya podés ingresar.";
      closeDialog($("#auth-dialog"));
    } else if (state.authMode === "signup") {
      const phone = values.whatsapp_number.replace(/\D/g, "");
      if (phone && !/^\d{8,15}$/.test(phone)) throw new Error("Ingresá un WhatsApp internacional de 8 a 15 dígitos.");
      const { data, error } = await state.supabase.auth.signUp({
        email: values.email.trim(),
        password: values.password,
        options: {
          data: {
            display_name: values.display_name.trim(),
            whatsapp_number: phone || null
          }
        }
      });
      if (error) throw error;
      if (data.session) {
        $("#auth-message").textContent = "Cuenta creada. Ya podés usar Frasco.";
        closeDialog($("#auth-dialog"));
      } else {
        $("#auth-message").textContent = "Cuenta creada. Revisá tu correo para confirmar el registro antes de ingresar.";
      }
    } else {
      const { error } = await state.supabase.auth.signInWithPassword({
        email: values.email.trim(),
        password: values.password
      });
      if (error) throw error;
      $("#auth-message").textContent = "Ingresaste correctamente.";
      closeDialog($("#auth-dialog"));
    }
  } catch (error) {
    reportError("No se pudo completar la autenticación", error, error.message?.startsWith("Ingresá un WhatsApp")
      ? error.message
      : "No se pudo completar la operación. Revisá el correo y la contraseña o intentá más tarde.");
  } finally {
    submit.disabled = false;
  }
}

async function resetPassword() {
  if (!requireClient()) return;
  const email = $("#auth-form").elements.email.value.trim();
  if (!email) {
    showToast("Escribí tu correo para enviarte el enlace de recuperación.", true);
    $("#auth-form").elements.email.focus();
    return;
  }
  const { error } = await state.supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}${window.location.pathname}`
  });
  if (error) {
    reportError("No se pudo solicitar el cambio de contraseña", error, "No se pudo enviar el enlace. Revisá el correo e intentá de nuevo.");
    return;
  }
  $("#auth-message").textContent = "Si el correo está registrado, vas a recibir un enlace para cambiar la contraseña.";
}

async function saveProfile(event) {
  event.preventDefault();
  if (!state.session) return;
  const values = formValues(event.currentTarget);
  const phone = values.whatsapp_number.replace(/\D/g, "");
  if (!/^\d{8,15}$/.test(phone)) {
    showToast("Ingresá un WhatsApp internacional válido, solo con dígitos.", true);
    return;
  }
  const { error } = await state.supabase.from("profiles").update({
    display_name: values.display_name.trim(),
    whatsapp_number: phone,
    contact_public: values.contact_public === "on"
  }).eq("id", state.session.user.id);
  if (error) {
    reportError("No se pudo guardar el perfil", error, "No se pudo guardar el perfil.");
    return;
  }
  await getSession();
  showToast("Perfil actualizado.");
  await loadListings();
}

async function handleSignOut() {
  const { error } = await state.supabase.auth.signOut();
  if (error) {
    reportError("No se pudo cerrar la sesión", error, "No se pudo cerrar la sesión.");
    return;
  }
  state.session = null;
  state.profile = null;
  state.favorites.clear();
  renderSession();
  await loadListings();
  showToast("Sesión cerrada.");
}

function bindEvents() {
  $("#filters").addEventListener("submit", event => {
    event.preventDefault();
    state.page = 1;
    loadListings().catch(error => reportError("No se pudo cargar el catálogo", error, "No se pudieron cargar las publicaciones."));
  });
  $("#previous-page").addEventListener("click", () => {
    if (state.page <= 1) return;
    state.page -= 1;
    loadListings().catch(error => reportError("No se pudo cargar el catálogo", error, "No se pudieron cargar las publicaciones."));
  });
  $("#next-page").addEventListener("click", () => {
    if (!state.hasNextPage) return;
    state.page += 1;
    loadListings().catch(error => reportError("No se pudo cargar el catálogo", error, "No se pudieron cargar las publicaciones."));
  });
  $("#sign-in-open").addEventListener("click", () => openAuth("signin"));
  $("#account-link").addEventListener("click", async () => {
    if (!state.session) {
      openAuth("signin");
      return;
    }
    $("#my-account").scrollIntoView({ behavior: "smooth" });
    await loadAccountData();
  });
  $("#sign-out").addEventListener("click", handleSignOut);
  $$("[data-open-listing]").forEach(button => button.addEventListener("click", () => openCreateListing()));
  $$("[data-close-dialog]").forEach(button => button.addEventListener("click", () => closeDialog($("#listing-dialog"))));
  $$(".dialog").forEach(dialog => {
    dialog.addEventListener("close", () => {
      if (!$(".dialog[open]")) document.body.classList.remove("dialog-open");
    });
    dialog.addEventListener("click", event => {
      if (event.target === dialog) closeDialog(dialog);
    });
  });
  $$("[data-auth-mode]").forEach(button => button.addEventListener("click", () => setAuthMode(button.dataset.authMode)));
  $("#auth-form").addEventListener("submit", submitAuth);
  $("#forgot-password").addEventListener("click", resetPassword);
  $("#listing-form").addEventListener("submit", saveListing);
  $("#report-form").addEventListener("submit", submitReport);
  $("#profile-form").addEventListener("submit", event => {
    saveProfile(event).catch(error => reportError("No se pudo guardar el perfil", error, "No se pudo guardar el perfil."));
  });
}

async function startServiceWorker() {
  if (!("serviceWorker" in navigator) || window.location.protocol === "file:") return;
  try {
    await navigator.serviceWorker.register("./sw.js");
  } catch (error) {
    console.error("[Frasco] No se pudo registrar el service worker", error);
    showStatus("El catálogo puede usarse, pero no se pudo habilitar la instalación como PWA.", true);
  }
}

async function initialize() {
  bindEvents();
  setAuthMode("signin");
  await startServiceWorker();

  const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(SUPABASE_URL)
    && SUPABASE_ANON_KEY.length > 20
    && !SUPABASE_ANON_KEY.includes("YOUR_");
  if (!configured) {
    $("#setup-banner").hidden = false;
    $("#empty-title").textContent = "El catálogo todavía no está conectado.";
    $("#empty-copy").textContent = "Configurá Supabase para cargar y consultar publicaciones reales.";
    return;
  }

  try {
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    state.supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    state.supabase.auth.onAuthStateChange((_event, session) => {
      state.session = session;
      window.setTimeout(async () => {
        try {
            if (_event === "PASSWORD_RECOVERY") openAuth("recovery");
            await getSession();
            await Promise.all([loadListings(), loadAccountData()]);
        } catch (error) {
          reportError("No se pudo actualizar la sesión", error, "No se pudieron cargar los datos de la cuenta.");
        }
      }, 0);
    });
    await getSession();
    await loadListings();
    if (state.session) await loadAccountData();
  } catch (error) {
    reportError("No se pudo iniciar la aplicación", error, "No se pudo conectar con Supabase. Revisá la configuración y la conexión a internet.");
    showStatus("La conexión a Supabase falló. Revisá la URL, la clave pública, las políticas CORS y que el proyecto esté activo.", true);
  }
}

initialize().catch(error => {
  reportError("Error de inicialización", error, "La aplicación no pudo iniciarse. Revisá la consola del navegador.");
});
